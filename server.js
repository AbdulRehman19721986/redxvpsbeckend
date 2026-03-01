// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redx';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional, for higher rate limits
const VPS_MANAGER_URL = process.env.VPS_MANAGER_URL; // e.g. http://your-vps-ip:3001
const VPS_API_KEY = process.env.VPS_API_KEY; // shared secret with VPS manager

// -------------------- MongoDB Models --------------------
const userSchema = new mongoose.Schema({
  githubUsername: { type: String, unique: true, required: true },
  isApproved: { type: Boolean, default: true },
  maxBots: { type: Number, default: 1 },
  expiryDate: Date,
  subscriptionPlan: String,
  deployedBots: [{ appName: String, serverId: Number, createdAt: Date }]
}, { timestamps: true });

const planSchema = new mongoose.Schema({
  name: String,
  price: String,
  duration: String,
  maxBots: Number,
  features: [String],
  isActive: { type: Boolean, default: true }
});

const serverSchema = new mongoose.Schema({
  name: String,
  url: String,
  apiKey: String,
  botCount: { type: Number, default: 0 },
  status: { type: String, default: 'online' }
});

const User = mongoose.model('User', userSchema);
const Plan = mongoose.model('Plan', planSchema);
const Server = mongoose.model('Server', serverSchema);

// -------------------- Helper: Check fork --------------------
async function checkFork(username) {
  try {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const url = `https://api.github.com/repos/AbdulRehman19721986/redxbot302/forks?per_page=100`;
    const resp = await axios.get(url, { headers });
    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork: !!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    console.error('GitHub API error:', e.message);
    return { hasFork: false, error: e.message };
  }
}

// -------------------- Routes --------------------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', admin: !!ADMIN_PASSWORD }));

// Get all plans (public)
app.get('/api/plans', async (req, res) => {
  const plans = await Plan.find({ isActive: true });
  res.json({ plans });
});

// Check fork and return user data
app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  let user = await User.findOne({ githubUsername: githubUsername.toLowerCase() });
  if (!user) {
    user = new User({ githubUsername: githubUsername.toLowerCase(), maxBots: 1 });
    await user.save();
  }

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: user.isApproved,
    maxBots: user.maxBots,
    expiryDate: user.expiryDate,
    subscriptionPlan: user.subscriptionPlan,
    deployedBots: user.deployedBots || [],
    currentBots: user.deployedBots?.length || 0
  });
});

// Deploy bot
app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId, appName, ...config } = req.body;
  if (!githubUsername || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await User.findOne({ githubUsername: githubUsername.toLowerCase() });
  if (!user || !user.isApproved) return res.status(403).json({ error: 'User not approved' });
  if (user.deployedBots.length >= user.maxBots) return res.status(403).json({ error: 'Bot limit reached' });

  // Select a server (simple round-robin)
  const servers = await Server.find({ status: 'online' });
  if (!servers.length) return res.status(500).json({ error: 'No available servers' });
  const server = servers[0]; // simplistic

  // Call VPS manager
  try {
    const deployResp = await axios.post(`${server.url}/deploy`, {
      apiKey: VPS_API_KEY,
      appName: appName || `${githubUsername}-${Date.now()}`,
      sessionId,
      config,
      githubUsername
    }, { timeout: 10000 });

    if (deployResp.data.success) {
      const newBot = {
        appName: deployResp.data.appName,
        serverId: server._id,
        createdAt: new Date()
      };
      user.deployedBots.push(newBot);
      await user.save();
      server.botCount += 1;
      await server.save();
      res.json({ success: true, appName: deployResp.data.appName });
    } else {
      res.status(500).json({ error: 'VPS deployment failed', details: deployResp.data });
    }
  } catch (e) {
    console.error('VPS call error:', e.message);
    res.status(500).json({ error: 'Could not reach VPS manager' });
  }
});

// Admin login
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

// Admin: get all users
app.post('/admin/users', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await User.find();
  res.json({ users });
});

// Admin: update user
app.post('/admin/update-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { githubUsername, isApproved, maxBots, expiryDate, subscriptionPlan } = req.body;
  await User.findOneAndUpdate(
    { githubUsername: githubUsername.toLowerCase() },
    { isApproved, maxBots, expiryDate, subscriptionPlan },
    { upsert: true }
  );
  res.json({ success: true });
});

// Admin: delete user
app.post('/admin/delete-user', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await User.deleteOne({ githubUsername: req.body.githubUsername.toLowerCase() });
  res.json({ success: true });
});

// Admin: get plans
app.post('/admin/plans', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plans = await Plan.find();
  res.json({ plans });
});

// Admin: create plan
app.post('/admin/create-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const plan = new Plan(req.body);
  await plan.save();
  res.json({ success: true });
});

// Admin: update plan
app.post('/admin/update-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { _id, ...data } = req.body;
  await Plan.findByIdAndUpdate(_id, data);
  res.json({ success: true });
});

// Admin: delete plan
app.post('/admin/delete-plan', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  await Plan.findByIdAndDelete(req.body._id);
  res.json({ success: true });
});

// Admin: get servers
app.post('/admin/servers', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const servers = await Server.find();
  res.json({ servers });
});

// Admin: get all bots (across servers)
app.post('/get-all-apps', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const users = await User.find();
  const apps = [];
  users.forEach(u => {
    u.deployedBots.forEach(b => apps.push({ ...b.toObject(), githubUsername: u.githubUsername }));
  });
  res.json({ apps });
});

// Bot actions (restart, config, delete)
app.post('/restart-app', async (req, res) => {
  const { appName } = req.body;
  // find which server hosts this app
  const user = await User.findOne({ 'deployedBots.appName': appName });
  if (!user) return res.status(404).json({ error: 'Bot not found' });
  const bot = user.deployedBots.find(b => b.appName === appName);
  const server = await Server.findById(bot.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const resp = await axios.post(`${server.url}/restart`, { apiKey: VPS_API_KEY, appName });
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ error: 'VPS call failed' });
  }
});

app.post('/get-config', async (req, res) => {
  const { appName } = req.body;
  // similar lookup, call VPS
  // ... (implement similarly)
  res.json({ success: false, message: 'Not implemented in example' });
});

app.post('/update-config', async (req, res) => {
  // ...
  res.json({ success: false });
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const user = await User.findOne({ githubUsername: githubUsername?.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const botIndex = user.deployedBots.findIndex(b => b.appName === appName);
  if (botIndex === -1) return res.status(404).json({ error: 'Bot not found' });
  const bot = user.deployedBots[botIndex];
  const server = await Server.findById(bot.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    await axios.post(`${server.url}/delete`, { apiKey: VPS_API_KEY, appName });
    user.deployedBots.splice(botIndex, 1);
    await user.save();
    server.botCount -= 1;
    await server.save();
    res.json({ success: true, message: 'Bot deleted' });
  } catch (e) {
    res.status(500).json({ error: 'VPS call failed' });
  }
});

app.post('/delete-multiple-apps', async (req, res) => {
  // batch delete (admin)
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { apps } = req.body;
  const results = { success: [], failed: [] };
  for (const { name, serverId } of apps) {
    try {
      const server = await Server.findById(serverId);
      if (server) {
        await axios.post(`${server.url}/delete`, { apiKey: VPS_API_KEY, appName: name });
        results.success.push(name);
      } else results.failed.push(name);
    } catch { results.failed.push(name); }
  }
  // also remove from User documents
  await User.updateMany(
    { 'deployedBots.appName': { $in: results.success } },
    { $pull: { deployedBots: { appName: { $in: results.success } } } }
  );
  res.json({ success: true, results });
});

// Simple buy-plan endpoint (generates WhatsApp link)
app.post('/api/buy-plan', (req, res) => {
  const { planName, price, githubUsername } = req.body;
  const message = `I want to buy the ${planName} plan (${price}). My GitHub: ${githubUsername}`;
  const whatsappLink = `https://wa.me/923346690239?text=${encodeURIComponent(message)}`;
  res.json({ whatsappLink });
});

// Connect to MongoDB and start server
const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}).catch(err => console.error('MongoDB error:', err));
