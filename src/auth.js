const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { loadUsers, saveUsers, appendAuditLog } = require('./snapshot');
require('dotenv').config();

// Secure secret fallback if JWT_SECRET environment variable is missing
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_EXPIRATION = '30d'; // 30-Day TTL

// In-memory set of revoked token IDs or tokens for remote session killing
const revokedTokens = new Set();

/**
 * Validate password strength: Must contain at least 1 number and 1 capital letter.
 */
function validatePasswordStrength(password) {
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }
  if (!/\d/.test(password)) {
    throw new Error('Password must contain at least 1 number (0-9).');
  }
  if (!/[A-Z]/.test(password)) {
    throw new Error('Password must contain at least 1 capital letter (A-Z).');
  }
}

/**
 * Initialize administrator on startup strictly from .env variables.
 * If ADMIN_USERNAME or ADMIN_PASSWORD are not set in .env, no default admin is created.
 */
async function initSeedAdmin() {
  try {
    const rawUsername = process.env.ADMIN_USERNAME;
    const rawPassword = process.env.ADMIN_PASSWORD;

    if (!rawUsername || !rawPassword) {
      console.log('ℹ️  No ADMIN_USERNAME / ADMIN_PASSWORD configured in .env. Skipping admin auto-seeding.');
      return;
    }

    const adminUsername = rawUsername.trim().toLowerCase();
    const adminPassword = rawPassword;

    let users = await loadUsers();

    // Check if an account matching ADMIN_USERNAME or the existing seed admin exists
    let adminUser = users.find(u => (u.username && u.username.toLowerCase() === adminUsername) || (u.role === 'admin' && u.isSeed));

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    if (!adminUser) {
      // Create new seed admin user
      const seedAdmin = {
        id: crypto.randomUUID(),
        username: adminUsername,
        displayName: 'Administrator',
        role: 'admin',
        approved: true,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        isSeed: true
      };
      users.push(seedAdmin);
      await saveUsers(users);
      console.log(`\n🔑 Initialized Administrator Account (${adminUsername}) from .env`);
    } else {
      // Sync username, password, role, and approved status for env admin if changed
      let updated = false;
      if (!adminUser.username || adminUser.username.toLowerCase() !== adminUsername) {
        adminUser.username = adminUsername;
        updated = true;
      }
      if (adminUser.role !== 'admin') {
        adminUser.role = 'admin';
        updated = true;
      }
      if (adminUser.approved !== true) {
        adminUser.approved = true;
        updated = true;
      }

      // Check if password in .env differs from database
      const isPwdMatch = await bcrypt.compare(adminPassword, adminUser.password);
      if (!isPwdMatch) {
        adminUser.password = hashedPassword;
        updated = true;
      }

      if (updated) {
        await saveUsers(users);
        console.log(`\n🔑 Synced Administrator Account (${adminUsername}) credentials from .env`);
      }
    }
  } catch (err) {
    console.error('   ❌ Failed to initialize/sync seed admin:', err.message);
  }
}

/**
 * Self-registration for new users. Ensures both username and email are unique.
 */
async function registerUser({ username, email, displayName, password }, clientIp = 'internal') {
  if (!username || !email || !password) {
    throw new Error('Username, email address, and password are required.');
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  
  if (cleanUsername.length < 3) {
    throw new Error('Username must be at least 3 characters long.');
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(cleanUsername)) {
    throw new Error('Username can only contain letters, numbers, dots, underscores, and hyphens.');
  }

  if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    throw new Error('Please enter a valid email address.');
  }

  // Password strength enforcement (1 number, 1 capital letter)
  validatePasswordStrength(password);

  const users = await loadUsers();

  // Check username uniqueness
  if (users.some(u => (u.username && u.username.toLowerCase() === cleanUsername) || (u.email && u.email.toLowerCase() === cleanUsername))) {
    throw new Error('Username is already taken.');
  }

  // Check email uniqueness
  if (users.some(u => (u.email && u.email.toLowerCase() === cleanEmail) || (u.username && u.username.toLowerCase() === cleanEmail))) {
    throw new Error('Email address is already registered.');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: crypto.randomUUID(),
    username: cleanUsername,
    email: cleanEmail,
    displayName: displayName ? displayName.trim() : cleanUsername,
    role: 'operator',
    approved: false, // Requires Administrator Approval
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  await saveUsers(users);

  await appendAuditLog({
    action: 'AUTH_SELF_REGISTER',
    username: cleanUsername,
    role: 'operator',
    details: `User self-registered from ${clientIp} (Email: ${cleanEmail}, Pending Admin Approval)`,
    ip: clientIp
  });

  // Send Telegram notification with Approve / Reject inline keyboard buttons
  try {
    const { sendMessage } = require('./telegram');
    const tgText = `🔔 <b>New User Registration Request</b>\n\n` +
      `👤 <b>Full Name:</b> ${newUser.displayName}\n` +
      `🆔 <b>Username:</b> <code>${newUser.username}</code>\n` +
      `📧 <b>Email:</b> ${newUser.email}\n` +
      `⏱ <b>Registered At:</b> <code>${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })} KL</code>\n\n` +
      `STATUS: ⏳ <i>Pending Administrator Approval</i>`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Approve Account', callback_data: `approve_user:${newUser.id}` },
        { text: '❌ Reject & Delete', callback_data: `reject_user:${newUser.id}` }
      ]]
    };

    const targetChat = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    if (targetChat) {
      await sendMessage(tgText, replyMarkup, targetChat);
    }
  } catch (tgErr) {
    console.error('   ⚠️ Failed to send Telegram registration notification:', tgErr.message);
  }

  return {
    success: true,
    message: 'Registration successful! Your account is pending administrator approval before you can access the dashboard.'
  };
}

/**
 * Authenticate user credentials via Username OR Email address.
 */
async function loginUser(identifier, password, clientIp = 'internal') {
  if (!identifier || !password) {
    throw new Error('Username/Email and password are required.');
  }

  const cleanId = identifier.trim().toLowerCase();
  const users = await loadUsers();
  
  // Allow login by Username OR Email
  const user = users.find(u => 
    (u.username && u.username.toLowerCase() === cleanId) || 
    (u.email && u.email.toLowerCase() === cleanId)
  );

  if (!user) {
    await appendAuditLog({
      action: 'AUTH_LOGIN_FAILED',
      username: identifier,
      role: 'anonymous',
      details: 'Invalid username or email',
      ip: clientIp
    });
    throw new Error('Invalid credentials.');
  }

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    await appendAuditLog({
      action: 'AUTH_LOGIN_FAILED',
      username: user.username,
      role: user.role,
      details: 'Incorrect password',
      ip: clientIp
    });
    throw new Error('Invalid credentials.');
  }

  // Check admin approval status
  if (user.approved === false) {
    await appendAuditLog({
      action: 'AUTH_LOGIN_BLOCKED_PENDING',
      username: user.username,
      role: user.role,
      details: 'Login blocked: Account pending admin approval',
      ip: clientIp
    });
    throw new Error('PENDING_APPROVAL: Your account is pending administrator approval. Please contact an admin to approve your account.');
  }

  const tokenId = crypto.randomUUID();
  const payload = {
    jti: tokenId,
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRATION });

  await appendAuditLog({
    action: 'AUTH_LOGIN_SUCCESS',
    username: user.username,
    role: user.role,
    details: `User logged in from ${clientIp}`,
    ip: clientIp
  });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      role: user.role,
      isSeed: !!user.isSeed,
      approved: user.approved !== false
    }
  };
}

/**
 * Revoke a token (used for remote session termination or logout).
 */
function revokeToken(tokenIdOrToken) {
  if (tokenIdOrToken) {
    revokedTokens.add(tokenIdOrToken);
  }
}

/**
 * Check if token has been revoked.
 */
function isTokenRevoked(token, jti) {
  return revokedTokens.has(token) || (jti && revokedTokens.has(jti));
}

/**
 * Parse HTTP Cookie header into an object key-value pair.
 */
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers && req.headers.cookie;
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * Express Middleware: Require Authentication
 */
function requireAuth(req, res, next) {
  let token = null;

  // 1. Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  } else {
    // 2. Fallback to HttpOnly cookie
    const cookies = parseCookies(req);
    if (cookies.sheets_auth_token) {
      token = cookies.sheets_auth_token;
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (isTokenRevoked(token, decoded.jti)) {
      return res.status(401).json({ error: 'Session has been revoked or logged out. Please log in again.' });
    }

    req.user = decoded;
    req.rawToken = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token. Please log in again.' });
  }
}

/**
 * Express Middleware Factory: Require Specific Role(s)
 * e.g. requireRole('admin', 'operator')
 */
function requireRole(...allowedRoles) {
  return function roleMiddleware(req, res, next) {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Forbidden. Insufficient permissions. Required role: ${allowedRoles.join(' or ')}.` 
      });
    }
    next();
  };
}

/**
 * Express Middleware: Require Admin Role
 */
const requireAdmin = requireRole('admin');

/**
 * Set HttpOnly cookie for session token.
 */
function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOptions = [
    `sheets_auth_token=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'Max-Age=2592000', // 30-day TTL
    'SameSite=Lax',
    ...(isProd ? ['Secure'] : [])
  ].join('; ');
  res.setHeader('Set-Cookie', cookieOptions);
}

/**
 * Clear HttpOnly auth cookie on logout.
 */
function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOptions = [
    'sheets_auth_token=',
    'HttpOnly',
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'SameSite=Lax',
    ...(isProd ? ['Secure'] : [])
  ].join('; ');
  res.setHeader('Set-Cookie', cookieOptions);
}

// ── In-Memory Rate Limiting ──────────────────────────────────────────────────
const rateLimitMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 10 * 60 * 1000).unref?.();

function createRateLimiter({ windowMs, maxRequests, message }) {
  return function rateLimiter(req, res, next) {
    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const ip = rawIp.split(',')[0].trim();
    const key = `${req.path}:${ip}`;
    const now = Date.now();

    let record = rateLimitMap.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      rateLimitMap.set(key, record);
      return next();
    }

    record.count += 1;
    if (record.count > maxRequests) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: message || `Too many requests. Please try again in ${retryAfter} seconds.`
      });
    }

    next();
  };
}

const loginRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 5,
  message: 'Too many login attempts. Please wait 1 minute before trying again.'
});

const registerRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 3,
  message: 'Too many registration requests from this IP. Please try again later.'
});

module.exports = {
  initSeedAdmin,
  registerUser,
  loginUser,
  revokeToken,
  requireAuth,
  requireAdmin,
  requireRole,
  setAuthCookie,
  clearAuthCookie,
  loginRateLimiter,
  registerRateLimiter,
  validatePasswordStrength,
  JWT_SECRET
};

