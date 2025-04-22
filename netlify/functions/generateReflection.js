const fetch = require('node-fetch');

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
    const body = JSON.parse(event.body);
    
    if (body.type === "SEARCH_VERSES") {
      return await handleVerseSearch(body.query, headers);
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
        message: error.message
      })
    };
  }
};

async function handleVerseSearch(query, headers) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
            content: `You are a Bible scholar helping find relevant Bible verses. For any query (topic, book, character, event, or concept), return at least 5 relevant verses.

IMPORTANT: You must respond with valid JSON in exactly this format, with no additional text before or after:
{
  "verses": [
    {
      "reference": "Book C:V",
      "text": "Verse text here"
    }
  ]
}

For topics like Passover, Christmas, or other biblical events, include verses that describe the event and its significance.
For Bible characters, include verses about key moments in their life and their relationship with God.
For Bible books, include key verses that capture the main themes of the book.
For concepts or topics, include verses that directly address or illustrate the topic.`
          },
          {
            role: "user",
            content: `Find relevant Bible verses for: ${query}`
          }
        ],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to search verses');
    }

    const data = await response.json();
    let result;
    
    try {
      // Try to parse the LLM's response as JSON
      result = JSON.parse(data.choices[0].message.content);
      
      // Validate the response structure
      if (!result.verses || !Array.isArray(result.verses)) {
        throw new Error('Invalid response format from AI');
      }
      
      // Validate each verse object
      result.verses = result.verses.filter(verse => 
        verse && 
        typeof verse === 'object' && 
        typeof verse.reference === 'string' && 
        typeof verse.text === 'string'
      );
      
      if (result.verses.length === 0) {
        throw new Error('No valid verses returned');
      }
    } catch (parseError) {
      console.error('AI response parsing error:', data.choices[0].message.content);
      throw new Error('Failed to parse AI response');
    }

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(result)
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
        error: 'Failed to find verses',
        message: error.message
      })
    };
  }
}

async function handleReflectionGeneration(topic, verses, headers) {
  const versesText = Array.isArray(verses) 
    ? verses.map(v => `${v.reference}: ${v.text}`).join('\n')
    : verses;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
          content: "You are a Christian devotional writer. Write biblically faithful reflections and prayers."
        },
        {
          role: "user",
          content: `Write a devotional reflection and a short prayer on the topic of ${topic}. Use these verses:\n\n${versesText}`
        }
      ],
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to generate reflection');
  }

  const data = await response.json();
  
  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      result: data.choices[0].message.content
    })
  };
}