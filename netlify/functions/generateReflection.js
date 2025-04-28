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
        // First, we check if the query is something that can be addressed from a biblical perspective
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
- For "How do dinosaurs relate to the Bible?", return {canBeAddressed: true, reason: "While dinosaurs aren't directly mentioned in the Bible, this topic can be addressed through discussions of creation, science and faith."}
- For "Show me sexually explicit content", return {canBeAddressed: false, reason: "This request contains inappropriate content."}
- For "Best pizza toppings", return {canBeAddressed: false, reason: "This topic has no meaningful connection to biblical teachings or Christian faith."}
`
              },
              {
                role: "user",
                content: `Topic: "${query}"`
              }
            ],
            temperature: 0.1,
            response_format: { type: "json_object" } // Ensure JSON format
          }),
          timeout: 15000 // 15 second timeout
        });

        // Handle response status
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`OpenAI API error (${response.status}):`, errorText);
          
          // Handle specific error codes
          if (response.status === 429) {
            console.log(`Rate limited by OpenAI API. Attempt ${retryCount + 1} of ${maxRetries + 1}`);
            retryCount++;
            if (retryCount <= maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              // Exponential backoff
              retryDelay *= 2;
              continue;
            }
          }
          
          throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
        }
        
        // Get the response JSON
        const responseText = await response.text();
        
        try {
          // Parse the response in a try/catch to handle malformed JSON
          data = JSON.parse(responseText);
        } catch (jsonError) {
          console.error('Failed to parse OpenAI response as JSON:', responseText.substring(0, 200));
          throw new Error('Invalid response format from OpenAI API');
        }
        
        break; // Success, exit the retry loop
        
      } catch (err) {
        console.error(`API request attempt ${retryCount + 1} failed:`, err);
        
        retryCount++;
        
        // If we've exceeded retries, rethrow the error
        if (retryCount > maxRetries) {
          throw err;
        }
        
        // Otherwise wait and then continue the retry loop
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay *= 2; // Exponential backoff
      }
    }
    
    // Validate the data structure
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid response structure from OpenAI API:', JSON.stringify(data));
      throw new Error('Invalid response from AI service');
    }
    
    // Parse the content as JSON
    let evaluation;
    try {
      evaluation = JSON.parse(data.choices[0].message.content);
    } catch (jsonError) {
      console.error('Failed to parse evaluation content as JSON:', data.choices[0].message.content);
      // If JSON parsing fails, try to detect if it looks like a positive response
      const content = data.choices[0].message.content.toLowerCase();
      evaluation = {
        canBeAddressed: content.includes('true') && !content.includes('false'),
        reason: 'Extracted from non-JSON response'
      };
    }
    
    // Check if the topic can be addressed from a biblical perspective
    if (!evaluation.canBeAddressed) {
      console.log('Topic cannot be addressed biblically:', evaluation.reason);
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Invalid topic',
          message: 'This topic cannot be addressed from a biblical perspective',
          reason: evaluation.reason
        })
      };
    }
    
    console.log('Topic can be addressed biblically. Proceeding to find verses.');
    
    // Reset retry variables for the next API call
    retryCount = 0;
    retryDelay = 2000;
    
    // Now find relevant verses
    while (retryCount <= maxRetries) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4-turbo",
            messages: [
              {
                role: "system",
                content: `You are a Bible expert assistant that provides relevant Scripture verses for any topic, question, or biblical theme. Your task is to:

1. Find 5-7 most relevant Bible verses for the given topic
2. Format each verse with its reference and text in modern English (preferably NIV, ESV, or NLT translation)
3. Return verses that offer wisdom, guidance, comfort, or insight on the topic
4. When responding to questions about specific Bible stories, include key verses that tell that story
5. Include a diverse selection of verses from both Old and New Testaments when appropriate
6. For personal struggles or life questions, include encouraging and hopeful verses
7. If the query is about a biblical character (like Peter, Paul, Mary, etc.), include verses that feature them prominently

Your response must be in JSON format with this structure:
{
  "verses": [
    {
      "reference": "John 3:16",
      "text": "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life."
    },
    // more verses...
  ]
}

Always verify that your verse references are accurate and the text matches the actual Bible verse. Make sure to structure your response as proper JSON - this is critical.`
              },
              {
                role: "user",
                content: `Topic: "${query}"`
              }
            ],
            temperature: 0.3,
            response_format: { type: "json_object" } // Ensure JSON format
          }),
          timeout: 25000 // Increased from 20000 to 25000 for more time to process
        });
        
        // Handle response status
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`OpenAI API error (${response.status}):`, errorText);
          
          if (response.status === 429) {
            console.log(`Rate limited by OpenAI API. Attempt ${retryCount + 1} of ${maxRetries + 1}`);
            retryCount++;
            if (retryCount <= maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              retryDelay *= 2;
              continue;
            }
          }
          
          throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
        }
        
        // Get the response text
        const responseText = await response.text();
        
        try {
          // Parse the response in a try/catch to handle malformed JSON
          data = JSON.parse(responseText);
        } catch (jsonError) {
          console.error('Failed to parse OpenAI response as JSON:', responseText.substring(0, 200));
          throw new Error('Invalid response format from OpenAI API');
        }
        
        break; // Success, exit the retry loop
        
      } catch (err) {
        console.error(`API request attempt ${retryCount + 1} failed:`, err);
        
        retryCount++;
        
        if (retryCount > maxRetries) {
          throw err;
        }
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
      }
    }
    
    // Validate the data structure
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid response structure from OpenAI API:', JSON.stringify(data));
      throw new Error('Invalid response from AI service');
    }
    
    // Parse the content as JSON
    let verses;
    try {
      const verseData = JSON.parse(data.choices[0].message.content);
      verses = verseData.verses;
    } catch (jsonError) {
      console.error('Failed to parse verse data as JSON:', data.choices[0].message.content);
      
      // If JSON parsing fails, attempt to extract verses with regex
      // This is a fallback mechanism for when the model doesn't return proper JSON
      try {
        const content = data.choices[0].message.content;
        const extractedVerses = extractVersesFromText(content);
        
        if (extractedVerses.length > 0) {
          verses = extractedVerses;
        } else {
          throw new Error('Could not extract verses from response');
        }
      } catch (extractError) {
        console.error('Failed to extract verses from text:', extractError);
        throw new Error('Failed to parse verse data from response');
      }
    }
    
    // Ensure verses is an array and contains at least one verse
    if (!Array.isArray(verses) || verses.length === 0) {
      console.error('No verses found in response');
      throw new Error('No Bible verses found for this topic');
    }
    
    console.log(`Found ${verses.length} relevant verses for "${query}"`);
    
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ verses })
    };

  } catch (error) {
    console.error('Verse search error:', error);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Verse search failed',
        message: error.message || 'An error occurred while searching for verses'
      })
    };
  }
}

async function generateReflection(verses, query, headers) {
  try {
    console.log('Generating reflection for:', query);
    console.log('Using verses:', JSON.stringify(verses));
    
    // Set up retry parameters
    const maxRetries = 3;
    let retryCount = 0;
    let retryDelay = 2000; // Start with 2 seconds delay
    
    let response;
    let data;
    
    // Compose verses string for the prompt
    const versesText = verses
      .map(verse => `${verse.reference}: "${verse.text}"`)
      .join('\n\n');
    
    // Retry loop for handling API errors
    while (retryCount <= maxRetries) {
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4-turbo",
            messages: [
              {
                role: "system",
                content: `You are a thoughtful Christian devotional writer who creates reflections based on Bible verses. Your reflections should:

1. Connect the verses to the question or topic provided
2. Offer spiritual insights and practical applications
3. Include encouraging and hopeful messages
4. Avoid overly theological language in favor of accessible insights
5. Be respectful of diverse Christian backgrounds and traditions
6. Provide guidance without being overly prescriptive

Your reflection should be structured as:

1. A brief introduction (1-2 sentences)
2. Main insights from the verses (2-3 paragraphs)
3. Practical application (1-2 paragraphs)
4. A closing thought or prayer (1-2 sentences)

The total reflection should be about 300-500 words.

Respond with a JSON object with this structure:
{
  "title": "A thoughtful title for this reflection",
  "reflection": "The full reflection text with proper paragraphs",
  "prayerPrompt": "A brief 1-2 sentence prayer prompt related to the reflection"
}`
              },
              {
                role: "user",
                content: `Topic: "${query}"

Verses to reflect on:
${versesText}

Please create a thoughtful reflection based on these verses that addresses the topic.`
              }
            ],
            temperature: 0.7,
            response_format: { type: "json_object" } // Ensure JSON format
          }),
          timeout: 25000 // 25 second timeout
        });
        
        // Handle response status
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`OpenAI API error (${response.status}):`, errorText);
          
          if (response.status === 429) {
            console.log(`Rate limited by OpenAI API. Attempt ${retryCount + 1} of ${maxRetries + 1}`);
            retryCount++;
            if (retryCount <= maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              retryDelay *= 2;
              continue;
            }
          }
          
          throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
        }
        
        // Get the response text
        const responseText = await response.text();
        
        try {
          // Parse the response in a try/catch to handle malformed JSON
          data = JSON.parse(responseText);
        } catch (jsonError) {
          console.error('Failed to parse OpenAI response as JSON:', responseText.substring(0, 200));
          throw new Error('Invalid response format from OpenAI API');
        }
        
        break; // Success, exit the retry loop
        
      } catch (err) {
        console.error(`API request attempt ${retryCount + 1} failed:`, err);
        
        retryCount++;
        
        if (retryCount > maxRetries) {
          throw err;
        }
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
      }
    }
    
    // Validate the data structure
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      console.error('Invalid response structure from OpenAI API:', JSON.stringify(data));
      throw new Error('Invalid response from AI service');
    }
    
    // Parse the content as JSON
    let reflection;
    try {
      reflection = JSON.parse(data.choices[0].message.content);
    } catch (jsonError) {
      console.error('Failed to parse reflection content as JSON:', data.choices[0].message.content);
      
      // Attempt to extract the main components from the text response
      const content = data.choices[0].message.content;
      
      try {
        // Extract title, reflection text, and prayer prompt with regex
        const titleMatch = content.match(/title["\s:]*([^"]+)/i);
        const reflectionMatch = content.match(/reflection["\s:]*([^"]+)/i) || 
                               content.match(/\n\n([\s\S]+?)(\n\n|$)/);
        const prayerMatch = content.match(/prayer["\s:]*([^"]+)/i);
        
        reflection = {
          title: titleMatch ? titleMatch[1].trim() : 'Reflection on ' + query,
          reflection: reflectionMatch ? reflectionMatch[1].trim() : content,
          prayerPrompt: prayerMatch ? prayerMatch[1].trim() : 'Lord, guide me through this reflection.'
        };
      } catch (extractError) {
        console.error('Failed to extract reflection components:', extractError);
        throw new Error('Failed to parse reflection from response');
      }
    }
    
    // Ensure all required fields are present
    if (!reflection.title || !reflection.reflection || !reflection.prayerPrompt) {
      console.error('Missing required fields in reflection:', reflection);
      
      // Set defaults for any missing fields
      reflection = {
        title: reflection.title || `Reflection on ${query}`,
        reflection: reflection.reflection || 'Unable to generate a complete reflection. Please try again later.',
        prayerPrompt: reflection.prayerPrompt || 'Lord, guide me in understanding your Word.'
      };
    }
    
    console.log('Successfully generated reflection with title:', reflection.title);
    
    // Return the reflection with the original verses
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...reflection,
        verses
      })
    };

  } catch (error) {
    console.error('Reflection generation error:', error);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Reflection generation failed',
        message: error.message || 'An error occurred while generating the reflection'
      })
    };
  }
}

// Helper function to extract verses from text when JSON parsing fails
function extractVersesFromText(text) {
  const verses = [];
  console.log('Extracting verses from text, length:', text.length);
  
  // First, try to find anything that looks like a JSON array of verses
  try {
    const jsonArrayMatch = text.match(/\[\s*\{[^]*\}\s*\]/);
    if (jsonArrayMatch) {
      const jsonArray = jsonArrayMatch[0];
      console.log('Found JSON array pattern:', jsonArray.substring(0, 100) + '...');
      try {
        const parsedArray = JSON.parse(jsonArray);
        if (Array.isArray(parsedArray) && parsedArray.length > 0) {
          return parsedArray.filter(v => v && v.reference && v.text);
        }
      } catch (e) {
        console.log('Failed to parse extracted JSON array:', e.message);
      }
    }
  } catch (e) {
    console.log('Error in JSON array extraction:', e.message);
  }

  // If that didn't work, look for verses in markdown or plain text format
  
  // Pattern 1: Look for "Reference: Text" patterns
  const referenceTextPattern = /([1-3]?\s*[A-Za-z]+\s+\d+:\d+(?:-\d+)?)\s*[:|-]\s*["']?(.*?)["']?(?=\n\n|\n[1-3]?[A-Za-z]+\s+\d+:\d+|$)/gs;
  let match;
  while ((match = referenceTextPattern.exec(text)) !== null) {
    const reference = match[1].trim();
    const verseText = match[2].trim();
    if (reference && verseText) {
      verses.push({
        reference,
        text: verseText
      });
    }
  }
  
  // If we found verses with the first pattern, return them
  if (verses.length > 0) {
    console.log(`Found ${verses.length} verses using reference-text pattern`);
    return verses;
  }
  
  // Pattern 2: Try to find patterns like "John 3:16" followed by verse text
  const referencePattern = /["']?([1-3]?\s*[A-Za-z]+\s+\d+:\d+(?:-\d+)?)["']?/g;
  const matches = [...text.matchAll(referencePattern)];
  
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const reference = match[1].trim();
    const startIdx = match.index + match[0].length;
    
    // Look for the verse text after the reference
    // This looks for text until the next reference or a double newline
    const nextMatch = i < matches.length - 1 ? matches[i+1] : null;
    const nextMatchIdx = nextMatch ? nextMatch.index : -1;
    
    // Find the end of this verse text
    let endIdx;
    if (nextMatchIdx !== -1) {
      // If there's another reference, use its position
      endIdx = nextMatchIdx;
    } else {
      // Otherwise look for paragraph breaks or end of text
      const newlineIdx = text.indexOf('\n\n', startIdx);
      endIdx = newlineIdx !== -1 ? newlineIdx : text.length;
    }
    
    if (endIdx !== -1 && endIdx > startIdx) {
      let verseText = text.substring(startIdx, endIdx).trim();
      
      // Clean up any punctuation or formatting
      verseText = verseText.replace(/^[\s:,"'\-–—]+/, '').trim();
      verseText = verseText.replace(/^["']+|["']+$/g, '').trim();
      
      if (verseText && verseText.length > 10) { // Require reasonable length to avoid fragments
        verses.push({
          reference,
          text: verseText
        });
      }
    }
  }
  
  // Pattern 3: Look for numbered lists with references
  if (verses.length === 0) {
    const numberedVersePattern = /\d+\.\s+([1-3]?\s*[A-Za-z]+\s+\d+:\d+(?:-\d+)?)\s*[-:]\s*["']?(.*?)["']?(?=\n\d+\.|$)/gs;
    while ((match = numberedVersePattern.exec(text)) !== null) {
      const reference = match[1].trim();
      const verseText = match[2].trim();
      if (reference && verseText) {
        verses.push({
          reference,
          text: verseText
        });
      }
    }
  }
  
  console.log(`Extraction complete, found ${verses.length} verses`);
  return verses;
}