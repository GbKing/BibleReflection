const fetch = require('node-fetch');

// In-memory storage for reflection generation status
// Use a more unique name to prevent conflicts with other functions
const REFLECTION_STORE = {};
const RATE_LIMIT_STORE = {};
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_POST_REQUESTS_PER_IP = 5; // 5 POST requests per minute (for starting new reflections)
const MAX_GET_REQUESTS_PER_IP = 60; // 60 GET requests per minute (for checking status)
const MAX_STORE_AGE_MS = 30 * 60 * 1000; // 30 minutes max storage

// Helper function to check rate limits
function checkRateLimit(ip, requestType) {
  const now = Date.now();
  const key = `${ip}-${requestType}`;
  
  // Clean up old entries
  Object.keys(RATE_LIMIT_STORE).forEach(existingKey => {
    if (now - RATE_LIMIT_STORE[existingKey].timestamp > RATE_WINDOW_MS) {
      delete RATE_LIMIT_STORE[existingKey];
    }
  });
  
  // Initialize if this key is new
  if (!RATE_LIMIT_STORE[key]) {
    RATE_LIMIT_STORE[key] = {
      count: 0,
      timestamp: now
    };
  }
  
  // If key exists but timestamp is old, reset the counter
  if (now - RATE_LIMIT_STORE[key].timestamp > RATE_WINDOW_MS) {
    RATE_LIMIT_STORE[key].count = 0;
    RATE_LIMIT_STORE[key].timestamp = now;
  }
  
  // Increment request count
  RATE_LIMIT_STORE[key].count++;
  
  // Return true if rate limit exceeded
  const limit = requestType === 'GET' ? MAX_GET_REQUESTS_PER_IP : MAX_POST_REQUESTS_PER_IP;
  return RATE_LIMIT_STORE[key].count > limit;
}

// Sanitize inputs to prevent injection attacks
function sanitizeInput(input, maxLength = 1000) {  // Increased default max length
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
      reference: sanitizeInput(verse.reference, 100),  // Increased from 50
      text: sanitizeInput(verse.text, 1000)  // Increased from 500
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
  
  // The rate limit check will be done separately for each HTTP method

  if (event.httpMethod === 'POST') {
    // Check rate limit for POST requests
    if (checkRateLimit(clientIP, 'POST')) {
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
      // Apply a more relaxed rate limit for GET requests (status checks)
      if (checkRateLimit(clientIP, 'GET')) {
        console.log(`GET rate limit exceeded for IP: ${clientIP}`);
        return {
          statusCode: 429,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Retry-After': '60'
          },
          body: JSON.stringify({
            error: 'Too many requests',
            message: 'Too many status checks. Please try again in a minute.'
          })
        };
      }
      
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
    console.log('Starting reflection generation for ID:', id);
    
    // Ensure we have valid input
    if (!topic) {
      console.error('Missing topic for reflection generation');
      throw new Error('Missing topic for reflection');
    }
    
    if (!verses || (Array.isArray(verses) && verses.length === 0)) {
      console.error('Missing verses for reflection generation');
      throw new Error('Missing verses for reflection');
    }
    
    // Validate and prepare verses text - use original verses without sanitization limits
    let versesToUse = verses;
    if (Array.isArray(verses) && verses.length > 10) {
      console.log(`Limiting from ${verses.length} verses to 10 verses to prevent token limit issues`);
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

    console.log('Generating reflection with topic:', topic);
    console.log('Using verses count:', Array.isArray(versesToUse) ? versesToUse.length : 'text input');

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
    
    // Ensure we have the OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API key is missing');
      throw new Error('API configuration error');
    }
    
    console.log('Sending request to OpenAI API...');
    
    // Set up retry parameters for handling rate limits
    const maxRetries = 3;
    let retryCount = 0;
    let retryDelay = 2000; // Start with 2 seconds delay
    let response;
    
    // Retry loop for handling rate limit errors
    while (retryCount <= maxRetries) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        });
        
        // Check if we got a rate limit error
        if (response.status === 429) {
          // Get the retry-after header if available
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;
          
          console.log(`OpenAI API rate limit hit. Retrying in ${waitTime/1000} seconds...`);
          
          // Update the store to indicate a retry is happening
          if (REFLECTION_STORE[id]) {
            REFLECTION_STORE[id].status = 'pending';
            REFLECTION_STORE[id].retryCount = (REFLECTION_STORE[id].retryCount || 0) + 1;
            REFLECTION_STORE[id].retryAfter = new Date(Date.now() + waitTime).toISOString();
          }
          
          // Wait for the recommended time or our exponential backoff
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Increase retry count and delay for next potential retry
          retryCount++;
          retryDelay *= 2; // Exponential backoff
          continue; // Skip to next iteration of the loop
        }
        
        // Break the loop if we didn't get a 429 error
        break;
        
      } catch (fetchError) {
        console.error('Fetch error:', fetchError);
        
        // If we've used all our retries, throw the error
        if (retryCount >= maxRetries) {
          throw fetchError;
        }
        
        // Otherwise, retry with exponential backoff
        retryCount++;
        retryDelay *= 2;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (!response.ok) {
      console.error(`API error: HTTP ${response.status}`);
      throw new Error(`API request failed with HTTP status ${response.status}`);
    }

    const data = await response.json();
    console.log('Received response from OpenAI API');
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid API response format');
    }
    
    // Make sure the reflection store still has this ID
    if (!REFLECTION_STORE[id]) {
      console.log(`Store entry for ${id} no longer exists, creating new entry`);
      REFLECTION_STORE[id] = {
        status: 'pending',
        started: new Date().toISOString()
      };
    }
    
    // Update store with completed result - don't sanitize the content further
    REFLECTION_STORE[id] = {
      status: 'completed',
      started: REFLECTION_STORE[id].started,
      completed: new Date().toISOString(),
      result: data.choices[0].message.content,
      error: null
    };
    
    console.log('Successfully generated and stored reflection for ID:', id);
    
  } catch (error) {
    console.error('Reflection generation error:', error.message);
    
    // Make sure the reflection store still has this ID
    if (!REFLECTION_STORE[id]) {
      REFLECTION_STORE[id] = {
        status: 'error',
        started: new Date().toISOString(),
        completed: new Date().toISOString(),
        result: null,
        error: 'Failed to generate reflection'
      };
    } else {
      // Update existing entry with error
      REFLECTION_STORE[id] = {
        status: 'error',
        started: REFLECTION_STORE[id].started, 
        completed: new Date().toISOString(),
        result: null,
        error: 'Failed to generate reflection'
      };
    }
  }
}