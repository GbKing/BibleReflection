# Bible Reflection App

An interactive web application that helps users find relevant Bible verses for any topic and generates thoughtful reflections and prayers based on the scriptures.

## Features

- Search for Bible verses by topic
- Clean presentation of relevant scriptures
- AI-powered devotional reflections and prayers
- Responsive design that works on all devices
- Automatic cleaning of scripture text

## Setup

1. Clone this repository
```bash
git clone https://github.com/yourusername/bible-reflection.git
cd bible-reflection
```

2. Set up your API key:
   - Copy `config.example.js` to `config.js`
   - Add your OpenAI API key to `config.js`

3. Open `index.html` in your web browser

## API Configuration

This project uses the OpenAI API for generating reflections and prayers:

1. Get your API key from [OpenAI](https://platform.openai.com)
2. Copy `config.example.js` to `config.js`
3. Add your API key to `config.js`

## Privacy Notice

The `config.js` file containing your API key is git-ignored to prevent accidentally committing sensitive information. Never commit your actual API keys to version control.