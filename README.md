# Bible Reflection App

An interactive web application that helps users find relevant Bible verses for any topic and generates thoughtful reflections and prayers based on the scriptures.

## Features

- Search for Bible verses by topic
- Clean presentation of relevant scriptures
- AI-powered devotional reflections and prayers
- Responsive design that works on all devices
- Automatic cleaning of scripture text

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