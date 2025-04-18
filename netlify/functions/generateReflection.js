const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse the incoming request body
    const { topic, verses } = JSON.parse(event.body);

    // Validate required fields
    if (!topic || !verses) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: topic and verses' })
      };
    }

    // Format verses for the prompt
    const versesText = Array.isArray(verses) 
      ? verses.map(v => `${v.reference}: ${v.text}`).join('\n')
      : verses;

    // Make request to OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

    // Handle API response
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to generate reflection');
    }

    const data = await response.json();
    
    // Return the generated content
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        result: data.choices[0].message.content
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to generate reflection',
        message: error.message
      })
    };
  }
};