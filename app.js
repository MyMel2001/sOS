require('dotenv').config(); // Load .env
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('@microsoft/microsoft-graph-client');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cron = require('node-cron');
const { ChatOllama } = require('@langchain/community/chat_models/ollama');
const { AgentExecutor, createToolCallingAgent } = require('langchain/agents');
const { pull } = require('langchain/hub');
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { QuickDB } = require('quick.db');
const RSSParser = require('rss-parser');
const db = new QuickDB(); // SQLite-based DB

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'your_jwt_secret'; // From .env
let COMPUTER_NAME = 'sOS'; // Admin can change via env var or .env

app.use(express.json());
app.use(express.static('public')); // Serve frontend

// DB Tables (using arrays for simplicity)
const getUsers = async () => await db.get('users') || [];
const saveUsers = async (users) => await db.set('users', users);

const getApps = async () => await db.get('apps') || [];
const saveApps = async (apps) => await db.set('apps', apps);

// RSS Feeds Map (hardcoded for categories)
const rssFeeds = {
  general: 'http://rss.cnn.com/rss/cnn_topstories.rss',
  business: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',
  entertainment: 'http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
  health: 'http://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
  science: 'http://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
  sports: 'https://www.espn.com/espn/rss/news',
  technology: 'http://feeds.arstechnica.com/arstechnica/technology-lab'
};

// Encryption Utils (unchanged)
function deriveKey(password) {
  return crypto.pbkdf2Sync(password, 'salt', 100000, 32, 'sha256');
}

function encryptFile(content, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptFile(encrypted, key) {
  const iv = encrypted.slice(0, 12);
  const tag = encrypted.slice(12, 28);
  const data = encrypted.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Filesystem Tools for Agent
const fileTools = [
  tool(async ({ action, filePath, content }) => {
    const user = getCurrentUser(); // From JWT
    const dir = path.join(__dirname, 'users', user.username, 'files');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fullPath = path.join(dir, filePath);
    const key = deriveKey(user.password);

    if (action === 'write') {
      const encrypted = encryptFile(content, key);
      fs.writeFileSync(fullPath, encrypted);
      return 'File written';
    } else if (action === 'read') {
      const data = fs.readFileSync(fullPath);
      return decryptFile(data, key).toString();
    } else if (action === 'delete') {
      fs.unlinkSync(fullPath);
      return 'File deleted';
    }
  }, {
    name: 'filesystem',
    description: 'Manage files: action (write/read/delete), filePath, content (for write)',
    schema: z.object({
      action: z.string(),
      filePath: z.string(),
      content: z.string().optional(),
    }),
  }),
];

// Office Suite Tools (unchanged)
const officeTools = [
  tool(async ({ type, content }) => {
    // Simulate doc creation; expand with libs
    if (type === 'word') return `Created doc: ${content}`;
    // Add spreadsheet, slides, etc.
  }, {
    name: 'office',
    description: 'Office actions: type (word/spreadsheet), content',
    schema: z.object({ type: z.string(), content: z.string() }),
  }),
];

// Web Action Tool (unchanged)
const webTool = tool(async ({ url, action }) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url);
  // Example: if action is 'fill form', evaluate JS
  const result = await page.evaluate((act) => {
    // Custom logic; e.g., document.querySelector('input').value = 'value';
    return 'Action performed';
  }, action);
  await browser.close();
  return result;
}, {
  name: 'web_action',
  description: 'Perform web actions (no games play): url, action description',
  schema: z.object({ url: z.string(), action: z.string() }),
});

// Game Help Tool (unchanged)
const gameHelpTool = tool(async ({ gameUrl, query }) => {
  // Analyze page or provide advice without automating
  return 'Advice: ...'; // Use AI to generate
}, {
  name: 'game_help',
  description: 'Help with web games: gameUrl, query',
  schema: z.object({ gameUrl: z.string(), query: z.string() }),
});

// Image Gen Tool
const imageTool = tool(async ({ prompt }) => {
  const user = getCurrentUser();
  const imageUrl = user.imageGenUrl || process.env.DEFAULT_IMAGE_GEN_URL;
  if (!imageUrl) return 'No image gen URL set (check user profile or .env)';
  const response = await axios.post(`${imageUrl}/sdapi/v1/txt2img`, { prompt });
  return response.data.images[0]; // Base64 image
}, {
  name: 'generate_image',
  description: 'Generate image: prompt',
  schema: z.object({ prompt: z.string() }),
});

// App Control Tool
const appControlTool = tool(async ({ appName, action }) => {
  const allApps = await getApps();
  const app = allApps.find(a => a.name === appName);
  if (!app) return 'App not found';
  // Execute app's defined tools
  return 'App action performed';
}, {
  name: 'control_app',
  description: 'Control installed app: appName, action',
  schema: z.object({ appName: z.string(), action: z.string() }),
});

// Notes/Reminders Tool
const notesTool = tool(async ({ action, note }) => {
  const user = getCurrentUser();
  if (action === 'add') user.notes.push(note);
  else if (action === 'list') return user.notes;
  await updateUser(user);
  return 'Notes updated';
}, {
  name: 'notes',
  description: 'Manage sticky notes/reminders: action (add/list), note',
  schema: z.object({ action: z.string(), note: z.string().optional() }),
});

// Calendar Tool (unchanged)
const calendarTool = tool(async ({ action, event }) => {
  const user = getCurrentUser();
  if (action === 'add') user.calendar.push(event);
  else if (action === 'list') return user.calendar;
  await updateUser(user);
  return 'Calendar updated';
}, {
  name: 'calendar',
  description: 'Manage calendar: action (add/list), event',
  schema: z.object({ action: z.string(), event: z.string().optional() }),
});

// Helper to update user in DB
async function updateUser(updatedUser) {
  let allUsers = await getUsers();
  allUsers = allUsers.map(u => u.username === updatedUser.username ? updatedUser : u);
  await saveUsers(allUsers);
}

// OneDrive Sync (unchanged)
async function syncOneDrive(user) {
  if (!user.onedriveToken) return;
  const client = Client.init({ authProvider: { getAccessToken: () => user.onedriveToken } });
  // List files and sync to local encrypted dir
  const files = await client.api('/me/drive/root/children').get();
  // Implement sync logic: Download/upload encrypted versions
}

// AI Agent Setup
async function getAgent(user) {
  let llm = new ChatOllama({
    baseUrl: user.customLLMUrl || process.env.DEFAULT_LLM_URL || 'http://localhost:11434',
    model: process.env.DEFAULT_LLM_MODEL || 'llama3'
  });
  const prompt = await pull('hwchase17/openai-functions-agent');
  const tools = [fileTools[0], officeTools[0], webTool[0], gameHelpTool[0], imageTool[0], appControlTool[0], notesTool[0], calendarTool[0]];
  const agent = await createToolCallingAgent({ llm, tools, prompt });
  return new AgentExecutor({ agent, tools });
}

// Signup
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  const allUsers = await getUsers();
  if (allUsers.find(u => u.username === username)) return res.status(400).send('Username taken');
  const hashed = await bcrypt.hash(password, 10);
  const newUser = { 
    username, 
    password: hashed, 
    onedriveToken: null, 
    customLLMUrl: null, 
    imageGenUrl: null, 
    preferences: {}, 
    notes: [], 
    calendar: [] 
  };
  allUsers.push(newUser);
  await saveUsers(allUsers);
  fs.mkdirSync(path.join(__dirname, 'users', username, 'files'), { recursive: true });
  res.send('User created');
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const allUsers = await getUsers();
  const user = allUsers.find(u => u.username === username);
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).send('Invalid creds');
  const token = jwt.sign({ username }, SECRET);
  if (user.onedriveToken) await syncOneDrive(user);
  res.json({ token });
});

// Middleware for Auth (unchanged)
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).send('Unauthorized');
  req.user = jwt.verify(token, SECRET);
  next();
}

async function getCurrentUser(req) {
  // Improved: Pass req or use global; here assume from req if available, else mock
  if (req && req.user) {
    const allUsers = await getUsers();
    return allUsers.find(u => u.username === req.user.username);
  }
  return { username: 'test', password: 'hashed' }; // Fallback mock
}

// Agent Chat Endpoint
app.post('/chat', auth, async (req, res) => {
  const { message } = req.body;
  const user = await getCurrentUser(req);
  const agentExecutor = await getAgent(user);
  const result = await agentExecutor.invoke({ input: message });
  // If needs confirmation, send back question; else respond
  res.json({ response: result.output });
});

// Publish App to Store
app.post('/publish-app', auth, async (req, res) => {
  const { name, description, html, tools } = req.body;
  let allApps = await getApps();
  allApps.push({ name, description, html, tools });
  await saveApps(allApps);
  res.send('App published');
});

// List Apps
app.get('/apps', auth, async (req, res) => {
  const allApps = await getApps();
  res.json(allApps);
});

// Set OneDrive Token
app.post('/onedrive', auth, async (req, res) => {
  const { token } = req.body;
  const user = await getCurrentUser(req);
  user.onedriveToken = token;
  await updateUser(user);
  await syncOneDrive(user);
  res.send('OneDrive enabled');
});

// Custom LLM/Image URL
app.post('/custom-ai', auth, async (req, res) => {
  const { llmUrl, imageUrl } = req.body;
  const user = await getCurrentUser(req);
  user.customLLMUrl = llmUrl;
  user.imageGenUrl = imageUrl;
  await updateUser(user);
  res.send('AI settings updated');
});

// Web Browse Proxy (unchanged)
app.get('/browse', auth, async (req, res) => {
  const { url } = req.query;
  const response = await axios.get(url);
  // Sanitize and render content
  res.send(`<div>${response.data}</div>`); // Basic; use cheerio for better parsing
});

// Daily News Cron
cron.schedule('0 8 * * *', async () => {
  const allUsers = await getUsers();
  const parser = new RSSParser();
  for (let user of allUsers) {
    if (!user.preferences || !user.preferences.news) continue;
    const category = user.preferences.news;
    const feedUrl = rssFeeds[category] || rssFeeds.general; // Fallback to general
    try {
      const feed = await parser.parseURL(feedUrl);
      const articles = feed.items.map(item => ({
        title: item.title,
        description: item.contentSnippet || item.content,
        link: item.link
      }));
      const agent = await getAgent(user);
      const curated = await agent.invoke({ input: `Curate daily news: ${JSON.stringify(articles)}` });
      // Store or notify user in chat log (implement as needed)
    } catch (error) {
      console.error(`Error fetching RSS for ${category}: ${error}`);
    }
  }
});

// Admin Set Computer Name (unchanged)
app.post('/admin/name', (req, res) => {
  COMPUTER_NAME = req.body.name;
  res.send('Name set');
});

app.listen(PORT, () => console.log(`sOS running on ${PORT}`));
