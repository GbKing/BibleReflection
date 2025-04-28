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
function sanitizeInput(input, maxLength = 1000) {
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

// AI-based topic evaluation function
async function evaluateTopicWithAI(topic) {
  if (!topic || typeof topic !== 'string' || topic.trim().length < 2) {
    console.log('Topic is too short or invalid');
    return { canBeAddressed: false, reason: 'Topic is too short or invalid' };
  }

  try {
    console.log('Evaluating topic with AI:', topic);
    
    // Set up retry parameters for OpenAI API calls
    const maxRetries = 2;
    let retryCount = 0;
    let retryDelay = 1000; // Start with 1 second delay
    
    let response;
    let data;
    
    // Retry loop for handling rate limit errors
    while (retryCount <= maxRetries) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content: `You are an assistant that evaluates whether a given topic or question can be addressed from a biblical or Christian perspective. Your task is to determine if the input can be meaningfully connected to:

1. Biblical teachings, principles, characters, events, or passages
2. Christian theology, ethics, or spiritual practices
3. Faith-based guidance that can be supported by scripture

If the query contains adult content, explicit material, hate speech, or content intended to harm, always return false.

For topics that aren't explicitly biblical but could be addressed through biblical principles (like modern issues, personal struggles, or contemporary figures), determine if there's a meaningful way to provide biblical guidance on the topic.

Respond with a JSON object containing:
- canBeAddressed: true or false
- reason: A brief explanation of your decision

For example:
- For "How do I forgive someone who hurt me?", return {canBeAddressed: true, reason: "Forgiveness is a central biblical teaching found throughout scripture."}
- For "Best cryptocurrencies to invest in", return {canBeAddressed: false, reason: "This is about financial investment specifics, not directly related to biblical principles."}
- For a political figure like "Bill Clinton", you might return {canBeAddressed: true, reason: "While not mentioned in scripture, biblical principles about leadership and prayer for authority figures apply."}`
              },
              {
                role: "user",
                content: `Can this query be addressed from a biblical perspective: "${topic}"?`
              }
            ],
            temperature: 0.3
          })
        });
        
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;
          
          console.log(`OpenAI API rate limit hit. Retrying in ${waitTime/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          retryCount++;
          retryDelay *= 2;
          continue;
        }
        
        break;
      } catch (fetchError) {
        console.error('Fetch error:', fetchError);
        if (retryCount >= maxRetries) {
          throw fetchError;
        }
        retryCount++;
        retryDelay *= 2;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (!response.ok) {
      console.error('OpenAI API error status:', response.status);
      // On API error, fail gracefully by assuming the topic is valid
      // This prevents blocking users due to API failures
      console.log('Assuming topic is valid due to API error');
      return { canBeAddressed: true, reason: 'API error, assuming valid topic' };
    }

    data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid OpenAI API response structure');
      // Again, fail gracefully
      return { canBeAddressed: true, reason: 'Invalid API response, assuming valid topic' };
    }
    
    // Parse the evaluation result
    const evaluationContent = data.choices[0].message.content.trim();
    let evaluation;
    
    try {
      // Parse the JSON response
      evaluation = JSON.parse(evaluationContent);
    } catch (parseError) {
      console.error('Failed to parse evaluation response:', parseError);
      
      // Try to extract JSON if it's wrapped in markdown or other text
      const jsonMatch = evaluationContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          evaluation = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.error('Failed to extract JSON from response');
          // If parsing fails, assume the topic is valid
          return { canBeAddressed: true, reason: 'Response parsing error, assuming valid topic' };
        }
      } else {
        // If no JSON found, assume the topic is valid
        return { canBeAddressed: true, reason: 'No JSON found in response, assuming valid topic' };
      }
    }
    
    console.log(`Topic evaluation result for "${topic}": ${evaluation.canBeAddressed ? 'Can be addressed' : 'Cannot be addressed'}`);
    return evaluation;
    
  } catch (error) {
    console.error('Topic evaluation error:', error);
    // In case of any error, allow the topic but log it
    return { canBeAddressed: true, reason: 'Error in evaluation process, assuming valid topic' };
  }
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
      
      // Use AI to evaluate if the topic can be addressed from a biblical perspective
      const evaluation = await evaluateTopicWithAI(sanitizedTopic);
      
      if (!evaluation.canBeAddressed) {
        console.log(`Rejecting non-Bible related topic: "${sanitizedTopic}", Reason: ${evaluation.reason}`);
        return {
          statusCode: 200, // Using 200 instead of 400 for better client handling
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            notBibleRelated: true,
            message: "I'm happy to help you with Bible-related topics, daily devotions, and Christian reflections. This topic doesn't appear to have a strong connection to biblical teachings or principles. If you'd like, you can ask about scriptures, biblical characters, Christian living, or how the Bible might provide guidance for specific life situations."
          })
        };
      }
      
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
      model: "gpt-3.5-turbo", // Changed from gpt-4-turbo to gpt-3.5-turbo for cheaper testing
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

// Bible topic validation
function isBibleRelatedTopic(query) {
  // Convert query to lowercase for case-insensitive matching
  const lowerQuery = query.toLowerCase().trim();
  
  // If query is too short, it might not be specific enough
  if (lowerQuery.length < 2) return false;
  
  // List of Bible-related keywords (books, characters, themes, concepts)
  const bibleBooks = [
    'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth',
    'samuel', 'kings', 'chronicles', 'ezra', 'nehemiah', 'esther', 'job', 'psalm', 'psalms',
    'proverbs', 'ecclesiastes', 'song of solomon', 'isaiah', 'jeremiah', 'lamentations',
    'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah', 'jonah', 'micah', 'nahum',
    'habakkuk', 'zephaniah', 'haggai', 'zechariah', 'malachi', 'matthew', 'mark', 'luke',
    'john', 'acts', 'romans', 'corinthians', 'galatians', 'ephesians', 'philippians',
    'colossians', 'thessalonians', 'timothy', 'titus', 'philemon', 'hebrews', 'james',
    'peter', 'jude', 'revelation'
  ];
  
  const bibleCharacters = [
    'jesus', 'christ', 'god', 'holy spirit', 'moses', 'abraham', 'isaac', 'jacob', 'joseph',
    'david', 'solomon', 'saul', 'paul', 'peter', 'mary', 'john', 'adam', 'eve', 'noah',
    'daniel', 'elijah', 'elisha', 'samson', 'delilah', 'goliath', 'joshua', 'rahab', 'ruth',
    'esther', 'job', 'jonah', 'jeremiah', 'isaiah', 'ezekiel', 'matthew', 'mark', 'luke',
    'john', 'timothy', 'titus', 'james', 'jude', 'sarah', 'rebekah', 'rachel', 'leah',
    'aaron', 'miriam', 'joshua', 'deborah', 'gideon', 'samuel', 'bathsheba', 'absalom',
    'martha', 'lazarus', 'nicodemus', 'thomas', 'judas', 'pilate', 'herod', 'cain', 'abel'
  ];
  
  const bibleThemes = [
    'salvation', 'faith', 'hope', 'love', 'sin', 'redemption', 'grace', 'forgiveness',
    'righteousness', 'holiness', 'prayer', 'worship', 'fellowship', 'gospel', 'repentance',
    'baptism', 'communion', 'lord\'s supper', 'crucifixion', 'resurrection', 'ascension',
    'second coming', 'judgment', 'heaven', 'hell', 'kingdom of god', 'church', 'discipleship',
    'evangelism', 'mission', 'ministry', 'prophecy', 'covenant', 'law', 'commandments',
    'blessing', 'curse', 'sacrifice', 'atonement', 'justification', 'sanctification',
    'glorification', 'wisdom', 'creation', 'fall', 'flood', 'exodus', 'promised land',
    'exile', 'return', 'incarnation', 'trinity', 'peace', 'joy', 'patience', 'kindness',
    'goodness', 'faithfulness', 'gentleness', 'self-control', 'mercy', 'justice'
  ];
  
  // Additional Bible-specific terms
  const bibleSpecificTerms = [
    'bible', 'scripture', 'verse', 'chapter', 'testament', 'gospel', 'epistle', 
    'prophet', 'apostle', 'disciple', 'messiah', 'christ', 'christian', 'church',
    'biblical', 'theology', 'sermon', 'parable', 'devotion', 'devotional', 'worship',
    'prayer', 'pray', 'spiritual', 'lord', 'tabernacle', 'temple', 'priest', 'levite',
    'pharisee', 'sadducee', 'sanhedrin', 'synagogue', 'sabbath', 'passover', 'pentecost'
  ];

  // List of explicitly non-biblical keywords that should be rejected
  const nonBiblicalKeywords = [
    'porn', 'sex', 'nude', 'bitcoin', 'invest', 'cryptocurrency', 'casino', 'gambling',
    'lottery', 'hack', 'cheat', 'drugs', 'marijuana', 'cocaine', 'heroin',
    'nazi', 'hitler', 'terrorism', 'bomb', 'weapon', 'gun', 'rifle', 'pistol', 'missile',
    'democrat', 'republican', 'trump', 'biden', 'obama', 'clinton', 'bush', 'reagan',
    'xbox', 'playstation', 'nintendo', 'fortnite', 'minecraft', 'roblox'
  ];

  // Check for explicit non-biblical keywords first (reject these immediately)
  for (const term of nonBiblicalKeywords) {
    // Use word boundaries to prevent false positives
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      console.log(`Rejected query "${query}" due to non-biblical keyword: ${term}`);
      return false;
    }
  }

  // Check if query directly contains any Bible book names (very likely biblical)
  for (const book of bibleBooks) {
    // Use word boundaries to ensure we're matching whole words
    const regex = new RegExp(`\\b${book}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return true;
    }
  }
  
  // Check if query directly contains any Bible character names (very likely biblical)
  for (const character of bibleCharacters) {
    // Use word boundaries for more accurate matching
    const regex = new RegExp(`\\b${character}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return true;
    }
  }
  
  // Check against Bible themes
  for (const theme of bibleThemes) {
    // Use word boundaries for more accurate matching
    const regex = new RegExp(`\\b${theme}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return true;
    }
  }
  
  // Check against Bible-specific terms
  for (const term of bibleSpecificTerms) {
    // Use word boundaries for more accurate matching
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return true;
    }
  }

  // Additional semantic checks for Bible-related phrases
  // These check for patterns that suggest Bible-related questions
  if (lowerQuery.includes('what does the bible say about')) return true;
  if (lowerQuery.includes('biblical perspective on')) return true;
  if (lowerQuery.includes('in the bible')) return true;
  if (lowerQuery.includes('scripture about')) return true;
  if (lowerQuery.includes('scriptures for')) return true;
  if (lowerQuery.includes('god\'s word')) return true;
  if (lowerQuery.includes('teaching of jesus')) return true;
  if (lowerQuery.includes('christian view')) return true;
  if (lowerQuery.includes('passage about')) return true;
  if (lowerQuery.includes('meaning of') && (lowerQuery.includes('verse') || lowerQuery.includes('passage'))) return true;
  if (lowerQuery.includes('interpretation of') && (lowerQuery.includes('verse') || lowerQuery.includes('passage'))) return true;
  if (lowerQuery.includes('how to pray')) return true;
  if (lowerQuery.includes('godly') || lowerQuery.includes('ungodly')) return true;
  if (lowerQuery.includes('daily devotional')) return true;
  if (lowerQuery.includes('what would jesus do')) return true;
  
  // Common Christian topics that might not be explicitly mentioned in our lists
  if (/\b(baptism|confession|repent|fast(ing)?|holy|communion|eucharist|tithe)\b/i.test(lowerQuery)) return true;
  if (/\b(sermon|parable|teaching|healing|miracle|sin(s)?|repent)\b/i.test(lowerQuery)) return true;
  if (/\b(worship|praise|thanksgiving|witness|ministry|pastor|church|temple)\b/i.test(lowerQuery)) return true;
  if (/\b(heaven|hell|salvation|eternal life|kingdom of god|kingdom of heaven)\b/i.test(lowerQuery)) return true;
  
  // Topics related to Christian theology
  const theologicalTerms = ["trinity", "incarnation", "atonement", "redemption", "justification", 
                           "sanctification", "predestination", "election", "calling", "salvation",
                           "rapture", "tribulation", "millennium", "dispensation", "covenant",
                           "reformed", "calvinist", "arminian", "catholic", "orthodox", "protestant"];
  
  for (const term of theologicalTerms) {
    if (lowerQuery.includes(term)) return true;
  }
  
  // If the query contains words with spiritual connotations, accept it
  const spiritualTerms = ["soul", "spirit", "divine", "sacred", "holy", "blessed", 
                          "faithful", "righteous", "sinful", "wicked", "evil",
                          "prayer", "worship", "praise", "blessing"];
                          
  for (const term of spiritualTerms) {
    if (lowerQuery.includes(term)) return true;
  }
  
  // If we're here, the query doesn't match any of our Bible-related patterns
  console.log(`Rejected query "${query}" as not Bible-related`);
  return false;
}