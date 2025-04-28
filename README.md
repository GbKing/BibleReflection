# Bible Reflection App

An interactive web application that helps users find relevant Bible verses for any topic and generates thoughtful reflections and prayers based on the scriptures.

## Features

- Search for Bible verses by topic
- Clean presentation of relevant scriptures
- AI-powered devotional reflections and prayers
- Responsive design that works on all devices
- Automatic cleaning of scripture text
- Robust error handling with automatic retry logic
- Enhanced UI with modern styling and visual feedback
- Keyboard support for better accessibility

## Recent Improvements

- **Enhanced Reliability**: Implemented automatic retry mechanism for both Scripture searches and reflection generation
- **Visual Retry Feedback**: Added user-friendly indicators showing retry progress
- **Robust JSON Parsing**: Improved handling of complex queries with advanced parsing techniques
- **Modern UI**: Updated with cleaner layout, visual feedback, and improved user experience
- **Loading States**: Added loading indicators for a better user experience during searches
- **Error Handling**: Better handling and display of error states
- **Security Enhancements**: Added comprehensive protection for public deployment (rate limiting, input validation, sanitization)

## Security Features

- **Rate limiting**: Protects against abuse with limits of 5 requests per minute per IP
- **Input validation**: Prevents malicious or excessively long inputs
- **Content filtering**: Basic filtering of inappropriate content
- **Data sanitization**: All inputs and outputs are sanitized to prevent injection attacks
- **Resource protection**: Automatic cleanup of stale data and prevention of memory leaks
- **Safe error handling**: User-friendly errors without exposing implementation details
- **Response sanitization**: All API responses are cleaned before returning to clients

## Setup

### Local Development

1. Clone this repository
```bash
git clone https://github.com/yourusername/bible-reflection.git
cd bible-reflection
```

2. Set up your API key:
   - Copy `config.example.js` to `config.js`
   - Add your OpenAI API key to `config.js`

3. Open `index.html` in your web browser or use a local server

### Netlify Deployment

This app is configured to work with Netlify's serverless functions:

1. Fork or clone this repository
2. Connect your GitHub repository to Netlify
3. Add your OpenAI API key as an environment variable in Netlify:
   - Go to Site settings > Build & deploy > Environment variables
   - Add a variable named `OPENAI_API_KEY` with your API key as the value
4. Deploy the site

## Architecture

The app uses two serverless functions:

1. `generateReflection.js` - Handles Bible verse searches and direct reflection generation for local development
2. `reflectionStatus.js` - Implements background processing for reflection generation on Netlify to avoid timeout issues

The frontend automatically detects whether it's running locally or on Netlify and uses the appropriate approach.

## Technical Details

### Scripture Search

The app uses a multi-stage parsing approach to handle responses from the OpenAI API, ensuring reliable results even for complex queries:

1. Direct JSON parsing for well-formed responses
2. Cleanup of markdown formatting and code blocks
3. Extraction of JSON objects from mixed content
4. Fixing of common syntax issues

### UI Elements

- Responsive design adapts to all screen sizes
- Visual feedback during loading states
- Enhanced error messages
- Keyboard accessibility (search with Enter key)
- Smooth transitions and hover effects

### Error Handling

- Automatic retries for transient failures
- Detailed error messages
- Console logging for troubleshooting

## API Configuration

This project uses the OpenAI API for generating reflections and prayers:

1. Get your API key from [OpenAI](https://platform.openai.com)
2. For local development:
   - Copy `config.example.js` to `config.js`
   - Add your API key to `config.js`
3. For Netlify deployment:
   - Add your API key as an environment variable named `OPENAI_API_KEY`

## Privacy Notice

The `config.js` file containing your API key is git-ignored to prevent accidentally committing sensitive information. Never commit your actual API keys to version control.