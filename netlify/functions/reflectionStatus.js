const fetch = require('node-fetch');

// In-memory storage for reflection generation status
// Use a more unique name to prevent conflicts with other functions
const REFLECTION_STORE = {};
const RATE_LIMIT_STORE = {};
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_IP = 5; // 5 requests per minute
const MAX_STORE_AGE_MS = 30 * 60 * 1000; // 30 minutes max storage

// Helper function to check rate limits
function checkRateLimit(ip) {
  const now = Date.now();
  
  // Clean up old entries
  Object.keys(RATE_LIMIT_STORE).forEach(key => {
    if (now - RATE_LIMIT_STORE[key].timestamp > RATE_WINDOW_MS) {
      delete RATE_LIMIT_STORE[key];
    }
  });
  
  // Initialize if this IP is new
  if (!RATE_LIMIT_STORE[ip]) {
    RATE_LIMIT_STORE[ip] = {
      count: 0,
      timestamp: now
    };
  }
  
  // If IP exists but timestamp is old, reset the counter
  if (now - RATE_LIMIT_STORE[ip].timestamp > RATE_WINDOW_MS) {
    RATE_LIMIT_STORE[ip].count = 0;
    RATE_LIMIT_STORE[ip].timestamp = now;
  }
  
  // Increment request count
  RATE_LIMIT_STORE[ip].count++;
  
  // Return true if rate limit exceeded
  return RATE_LIMIT_STORE[ip].count > MAX_REQUESTS_PER_IP;
}

// Sanitize inputs to prevent injection attacks
function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== 'string') {
    return '';
  }
  return input.trim().substring(0, maxLength);
}

// Validate and sanitize verse objects
function validateVerses(verses, maxVerses = 10) {
  if (!Array.isArray(verses)) {
    return [];
  }
  
  return verses
    .filter(verse => 
      verse && 
      typeof verse === 'object' && 
      typeof verse.reference === 'string' && 
      typeof verse.text === 'string'
    )
    .map(verse => ({
      reference: sanitizeInput(verse.reference, 50),
      text: sanitizeInput(verse.text, 500)
    }))
    .slice(0, maxVerses); // Limit total number of verses
}

// Clean up stale entries in the reflection store
function cleanupStaleEntries() {
  const now = Date.now();
  Object.keys(REFLECTION_STORE).forEach(id => {
    const entry = REFLECTION_STORE[id];
    // Convert ISO string to timestamp for comparison
    const startTime = new Date(entry.started).getTime();
    if (now - startTime > MAX_STORE_AGE_MS) {
      delete REFLECTION_STORE[id];
    }
  });
}

exports.handler = async function(event, context) {
  // Clean up stale entries periodically
  cleanupStaleEntries();
  
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers
    };
  }
  
  // Get client IP for rate limiting
  const clientIP = event.headers['client-ip'] || 
                 event.headers['x-forwarded-for'] || 
                 'unknown-ip';
  
  // Check rate limit
  if (checkRateLimit(clientIP)) {
    console.log(`Rate limit exceeded for IP: ${clientIP}`);
    return {
      statusCode: 429,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Retry-After': '60'
      },
      body: JSON.stringify({
        error: 'Too many requests',
        message: 'Please try again in a minute'
      })
    };
  }

  if (event.httpMethod === 'POST') {
    // Start a new reflection generation process
    try {
      if (!event.body) {
        throw new Error('Missing request body');
      }
      
      const body = JSON.parse(event.body);
      
      if (!body.topic || !body.verses) {
        throw new Error('Missing required parameters');
      }
      
      // Sanitize topic
      const sanitizedTopic = sanitizeInput(body.topic);
      
      // Validate and sanitize verses
      const validatedVerses = validateVerses(body.verses);
      
      if (validatedVerses.length === 0) {
        throw new Error('No valid verses provided');
      }
      
      // Generate unique ID for this reflection request
      const reflectionId = generateUniqueId();
      
      // Store initial status
      REFLECTION_STORE[reflectionId] = {
        status: 'pending',
        started: new Date().toISOString(),
        result: null,
        error: null
      };
      
      // Start async generation (don't await)
      generateReflection(reflectionId, sanitizedTopic, validatedVerses);
      
      // Return the ID immediately
      return {
        statusCode: 202, // Accepted
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: reflectionId,
          status: 'pending'
        })
      };
    } catch (error) {
      console.error('Error starting reflection:', error.message);
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Invalid request',
          message: 'Please provide valid topic and verses'
        })
      };
    }
  } else if (event.httpMethod === 'GET') {
    // Check status of a reflection generation process
    try {
      const reflectionId = sanitizeInput(event.queryStringParameters?.id || '');
      
      if (!reflectionId || !REFLECTION_STORE[reflectionId]) {
        return {
          statusCode: 404,
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            error: 'Not found',
            message: 'Reflection not found'
          })
        };
      }
      
      const reflection = REFLECTION_STORE[reflectionId];
      
      // Create a safe response object that doesn't include internal details
      const safeResponse = {
        status: reflection.status,
        // Only return result if status is completed
        result: reflection.status === 'completed' ? reflection.result : null,
        // Provide generic error message rather than exposing internal errors
        error: reflection.status === 'error' ? 'An error occurred' : null
      };
      
      // If it's completed or error, we can delete from the store after sending
      const shouldDelete = ['completed', 'error'].includes(reflection.status);
      const response = {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(safeResponse)
      };
      
      // Clean up completed entries
      if (shouldDelete) {
        setTimeout(() => {
          delete REFLECTION_STORE[reflectionId];
        }, 60000); // Delete after 1 minute
      }
      
      return response;
    } catch (error) {
      console.error('Error checking reflection status:', error.message);
      return {
        statusCode: 500,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Server error',
          message: 'Something went wrong. Please try again.'
        })
      };
    }
  } else {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
};

// Generate a unique ID for reflection requests
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Generate reflection without blocking the response
async function generateReflection(id, topic, verses) {
  try {
    // Validate and prepare verses text
    let versesToUse = verses;
    if (Array.isArray(verses) && verses.length > 10) {
      versesToUse = verses.slice(0, 10);
    }

    const versesText = Array.isArray(versesToUse) 
      ? versesToUse.map(v => {
          if (!v || !v.reference || !v.text) {
            return '';
          }
          return `${v.reference}: ${v.text}`;
        }).filter(Boolean).join('\n')
      : versesToUse;

    if (!versesText.trim()) {
      throw new Error('No valid verse text available');
    }

    // Prepare API request
    const requestBody = {
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: `You are a Christian devotional writer with deep theological understanding and a gift for reflection. 
Your goal is to create profound, thoughtful reflections on spiritual topics that engage the reader in meaningful contemplation.
Your reflections should be original, insightful, and thought-provoking, not merely explanations of Bible verses.
Include scriptural references naturally within your writing, but don't simply explain the verses.
End with a heartfelt prayer that relates to the topic and the spiritual journey of the reader.`
        },
        {
          role: "user",
          content: `Write a deep, thoughtful Christian reflection on the topic of "${topic}". 
          
Some relevant scriptures for this topic include:

${versesText}

However, don't simply explain these verses. Instead, provide a robust, contemplative reflection on the topic itself. 
Consider theological implications, personal application, and spiritual growth. 
The reflection should be profound and insightful, drawing on biblical wisdom but not limited to only the verses listed.
End with a meaningful prayer related to this topic.`
        }
      ],
      temperature: 0.7
    };
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText.substring(0, 100)}`);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid API response format');
    }
    
    // Update store with completed result
    REFLECTION_STORE[id] = {
      status: 'completed',
      started: REFLECTION_STORE[id].started,
      completed: new Date().toISOString(),
      result: data.choices[0].message.content,
      error: null
    };
    
  } catch (error) {
    // Update store with error
    REFLECTION_STORE[id] = {
      status: 'error',
      started: REFLECTION_STORE[id].started,
      completed: new Date().toISOString(),
      result: null,
      error: error.message
    };
  }
}