const fetch = require('node-fetch');

// Simple in-memory rate limiting store
// Note: This is reset whenever the function is re-deployed
const RATE_LIMIT_STORE = {};
const RATE_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_IP = 10; // Increased from 5 to 10 requests per minute

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
function sanitizeInput(input, maxLength = 1000) {  // Increased default max length
  if (typeof input !== 'string') {
    return '';
  }
  return input.trim().substring(0, maxLength);
}

/**
 * Netlify serverless function that:
 * 1. Uses GPT-4-turbo to find relevant Bible verses for any topic, book, or character
 * 2. Generates a Christian devotional reflection and prayer based on those verses
 * 
 * Expected POST body format for verse search:
 * {
 *   query: string,
 *   type: "SEARCH_VERSES"
 * }
 * 
 * Expected POST body format for reflection:
 * {
 *   topic: string,
 *   verses: Array<{reference: string, text: string}>,
 *   type: "GENERATE_REFLECTION"
 * }
 */
exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
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

    // Parse and validate request body
    if (!event.body) {
      throw new Error('Missing request body');
    }
    
    const body = JSON.parse(event.body);
    
    if (!body.type || typeof body.type !== 'string') {
      throw new Error('Invalid request type');
    }
    
    if (body.type === "SEARCH_VERSES") {
      if (!body.query || typeof body.query !== 'string') {
        throw new Error('Invalid query parameter');
      }
      
      // Sanitize query
      const query = sanitizeInput(body.query);
      return await handleVerseSearch(query, headers);
    } else if (body.type === "GENERATE_REFLECTION") {
      return await handleReflectionGeneration(body.topic, body.verses, headers);
    } else {
      throw new Error('Invalid request type');
    }

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Function failed',
        message: 'An error occurred while processing your request'
      })
    };
  }
};

async function handleVerseSearch(query, headers) {
  try {
    console.log('Starting verse search for query:', query);
    
    // Set up retry parameters for OpenAI API calls
    const maxRetries = 3;
    let retryCount = 0;
    let retryDelay = 2000; // Start with 2 seconds delay
    
    let response;
    let data;
    
    // Retry loop for handling rate limit errors
    while (retryCount <= maxRetries) {
      try {
        // Improve the system prompt with clearer formatting instructions without specific examples
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo", // Changed from gpt-4-turbo to gpt-3.5-turbo for cheaper testing
            messages: [
              {
                role: "system",
                content: `You are a Bible scholar helping find relevant Bible verses. For any query (topic, book, character, event, or concept), return at least 5 relevant verses.

IMPORTANT: You must respond with ONLY clean, valid JSON in exactly this format with no additional text:
{
  "verses": [
    {
      "reference": "Book C:V",
      "text": "Verse text here"
    }
  ]
}

DO NOT include any markdown formatting, code blocks, or explanatory text.
DO NOT surround your response with backticks.
ONLY respond with the raw JSON object - nothing before, nothing after.

For topics about biblical events, include verses that describe the event and its significance.
For Bible characters, include verses about key moments in their life and their relationship with God.
For Bible books, include key verses that capture the main themes of the book.
For concepts or topics, include verses that directly address or illustrate the topic.`
              },
              {
                role: "user",
                content: `Find relevant Bible verses for: ${query}`
              }
            ],
            temperature: 0.3 // Using a lower temperature for more consistent formatting
          })
        });
        
        // Check if we got a rate limit error
        if (response.status === 429) {
          // Get the retry-after header if available
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;
          
          console.log(`OpenAI API rate limit hit. Retrying in ${waitTime/1000} seconds...`);
          
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
      // Don't log the entire error response as it might contain sensitive information
      console.error('OpenAI API error status:', response.status);
      throw new Error(`Failed to search verses (HTTP ${response.status})`);
    }

    data = await response.json();
    
    // Add logging to help troubleshoot any response content issues
    console.log('API response received:', data.choices && data.choices.length ? 'Valid choices' : 'No choices');
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid OpenAI API response structure');
      throw new Error('Invalid response structure from OpenAI API');
    }
    
    const contentString = data.choices[0].message.content.trim();
    console.log('Response content preview length:', contentString.length);
    
    let result;
    
    try {
      // Multi-stage parsing approach with advanced cleanup
      
      // 1. First attempt direct parsing
      try {
        result = JSON.parse(contentString);
      } catch (initialParseError) {
        console.log('Initial JSON parsing failed, attempting cleanup');
        
        // 2. Try to clean up the response
        let cleanedContent = contentString;
        
        // Remove any markdown code blocks
        cleanedContent = cleanedContent
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();
        
        // Try to extract just the JSON object if there's other text
        const jsonRegex = /(\{[\s\S]*\})/g;
        const jsonMatch = cleanedContent.match(jsonRegex);
        
        if (jsonMatch && jsonMatch.length > 0) {
          cleanedContent = jsonMatch[0];
          console.log('Extracted JSON object from mixed content');
        }
        
        // 3. Try parsing with cleaned content
        try {
          result = JSON.parse(cleanedContent);
          console.log('Successfully parsed JSON after cleaning');
        } catch (cleanParseError) {
          // 4. Last resort - try to fix common JSON syntax issues
          try {
            // Replace single quotes with double quotes (common GPT error)
            const doubleQuoteContent = cleanedContent.replace(/'/g, '"');
            result = JSON.parse(doubleQuoteContent);
            console.log('Successfully parsed JSON after replacing quotes');
          } catch (fixedParseError) {
            console.error('All JSON parsing attempts failed');
            throw initialParseError; // Throw original error if all attempts fail
          }
        }
      }
      
      // Validate the response structure
      if (!result.verses || !Array.isArray(result.verses)) {
        throw new Error('Invalid response format from AI - missing verses array');
      }
      
      // Validate each verse object but avoid over-sanitization
      const processedVerses = result.verses.filter(verse => 
        verse && 
        typeof verse === 'object' && 
        typeof verse.reference === 'string' && 
        typeof verse.text === 'string'
      ).map(verse => ({
        reference: verse.reference,  // Keep original reference
        text: verse.text  // Keep original text
      }));
      
      // Take at most 15 verses but don't truncate if less
      const limitedVerses = processedVerses.length > 15 ? 
        processedVerses.slice(0, 15) : 
        processedVerses;
      
      if (limitedVerses.length === 0) {
        throw new Error('No valid verses returned from AI');
      }
      
      console.log(`Successfully parsed ${limitedVerses.length} verses for query "${query}"`);
      
      // Return a new object with the processed verses
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          verses: limitedVerses
        })
      };
      
    } catch (parseError) {
      console.error('AI response parsing error:', parseError.message);
      throw new Error('Failed to parse AI response');
    }
  } catch (error) {
    console.error('Verse search error:', error.message);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Failed to find verses',
        message: 'Could not find Bible verses for your query. Please try again later.'
      })
    };
  }
}

async function handleReflectionGeneration(topic, verses, headers) {
  try {
    // Validate and sanitize input
    if (!topic || typeof topic !== 'string') {
      throw new Error('Invalid topic provided');
    }
    
    if (!verses || (!Array.isArray(verses) && typeof verses !== 'string')) {
      throw new Error('Invalid verses data provided');
    }
    
    // Sanitize topic
    const sanitizedTopic = sanitizeInput(topic);
    
    // Limit number of verses to prevent token limit issues and sanitize each verse
    let versesToUse = verses;
    if (Array.isArray(verses)) {
      if (verses.length > 10) {
        console.log(`Limiting from ${verses.length} verses to 10 verses to prevent token limit issues`);
      }
      
      // Take maximum 10 verses and sanitize them
      versesToUse = verses
        .slice(0, 10)
        .map(v => {
          if (!v || !v.reference || !v.text) {
            return null;
          }
          return {
            reference: sanitizeInput(v.reference, 50),
            text: sanitizeInput(v.text, 500)
          };
        })
        .filter(Boolean); // Remove any null entries
    } else if (typeof verses === 'string') {
      // If string input, just sanitize it
      versesToUse = sanitizeInput(verses, 5000);
    }

    // Ensure we have verses to work with
    const versesText = Array.isArray(versesToUse) 
      ? versesToUse.map(v => `${v.reference}: ${v.text}`).join('\n')
      : versesToUse;

    if (!versesText.trim()) {
      throw new Error('No valid verse text available');
    }

    console.log('Generating reflection for topic:', sanitizedTopic);
    console.log('Using verses count:', Array.isArray(versesToUse) ? versesToUse.length : 'text input');
    console.log('API Key defined:', !!process.env.OPENAI_API_KEY);

    // Prepare API request with sanitized inputs
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
          content: `Write a deep, thoughtful Christian reflection on the topic of "${sanitizedTopic}". 
          
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
    
    console.log('Request prepared, sending to OpenAI API');
    
    // Set up retry parameters
    const maxRetries = 3;
    let retryCount = 0;
    let retryDelay = 2000; // Start with 2 seconds
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
        
        // Check for rate limit error
        if (response.status === 429) {
          // Get retry-after header if available
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;
          
          console.log(`OpenAI API rate limit hit for reflection. Retrying in ${waitTime/1000} seconds...`);
          
          // Wait for the recommended time or use exponential backoff
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Update retry count and delay
          retryCount++;
          retryDelay *= 2; // Exponential backoff
          continue;
        }
        
        // If not a 429 error, break out of the loop
        break;
        
      } catch (fetchError) {
        console.error('Fetch error in reflection generation:', fetchError);
        
        if (retryCount >= maxRetries) {
          throw fetchError;
        }
        
        // Retry with exponential backoff
        retryCount++;
        retryDelay *= 2;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (!response.ok) {
      console.error('OpenAI API error response status:', response.status);
      throw new Error(`OpenAI API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid OpenAI response format');
      throw new Error('Invalid response from OpenAI API');
    }
    
    // Sanitize the reflection content before returning
    const sanitizedResult = sanitizeInput(data.choices[0].message.content, 10000);
    console.log('Reflection generated successfully');
    
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        result: sanitizedResult
      })
    };
  } catch (error) {
    console.error('Reflection generation error:', error.message);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Failed to generate reflection',
        message: 'Unable to generate a reflection at this time. Please try again later.'
      })
    };
  }
}