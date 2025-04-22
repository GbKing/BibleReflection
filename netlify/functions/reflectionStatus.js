const fetch = require('node-fetch');

// In-memory storage for reflection generation status
// In a production app, you'd use a proper database or cache service
const reflectionStore = {};

exports.handler = async function(event, context) {
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

  if (event.httpMethod === 'POST') {
    // Start a new reflection generation process
    try {
      const body = JSON.parse(event.body);
      
      if (!body.topic || !body.verses) {
        throw new Error('Missing required parameters');
      }
      
      // Generate unique ID for this reflection request
      const reflectionId = generateUniqueId();
      
      // Store initial status
      reflectionStore[reflectionId] = {
        status: 'pending',
        started: new Date().toISOString(),
        result: null,
        error: null
      };
      
      // Start async generation (don't await)
      generateReflection(reflectionId, body.topic, body.verses);
      
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
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Invalid request',
          message: error.message
        })
      };
    }
  } else if (event.httpMethod === 'GET') {
    // Check status of a reflection generation process
    try {
      const reflectionId = event.queryStringParameters?.id;
      
      if (!reflectionId || !reflectionStore[reflectionId]) {
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
      
      const reflection = reflectionStore[reflectionId];
      
      // If it's completed, we can delete from the store after sending
      const shouldDelete = ['completed', 'error'].includes(reflection.status);
      const response = {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(reflection)
      };
      
      // Clean up old entries (in real app, use proper TTL mechanism)
      if (shouldDelete) {
        setTimeout(() => {
          delete reflectionStore[reflectionId];
        }, 60000); // Delete after 1 minute
      }
      
      return response;
    } catch (error) {
      return {
        statusCode: 500,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Server error',
          message: error.message
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
    reflectionStore[id] = {
      status: 'completed',
      started: reflectionStore[id].started,
      completed: new Date().toISOString(),
      result: data.choices[0].message.content,
      error: null
    };
    
  } catch (error) {
    // Update store with error
    reflectionStore[id] = {
      status: 'error',
      started: reflectionStore[id].started,
      completed: new Date().toISOString(),
      result: null,
      error: error.message
    };
  }
}