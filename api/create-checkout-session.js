/**
 * /api/create-checkout-session
 * -----------------------------------------------------------------------------
 * Vercel serverless function that creates a Stripe Checkout Session for a
 * FieldsCraft Lawn Care booking.
 *
 * Flow:
 *  1. book.html POSTs booking form data here (JSON)
 *  2. We pick the correct main service Price ID
 *  3. We create a Checkout Session with optional add-ons + tip
 *  4. We return { url } so the browser can redirect to Stripe
 *
 * SECURITY: STRIPE_SECRET_KEY is read only from process.env on the server.
 * It must NEVER be put in frontend HTML/JS.
 * -----------------------------------------------------------------------------
 */

const Stripe = require('stripe');

// ---- Live Stripe Price IDs (Dashboard → Products) ----
const PRICE_IDS = {
  // Main services (required line_item — customer always pays for one of these)
  basic: 'price_1TrqNmIwpXk8ife0hEw0Smla', // Basic Mow
  full: 'price_1TrqNmIwpXk8ife0jlQYnV4t', // Full Yard Service

  // Optional add-ons shown on the Stripe Checkout page (fixed-price products)
  flowerWatering: 'price_1Ts5ZKIwpXk8ife07lehq9P1', // Flower Watering
  dogPoopPickup: 'price_1Ts5aEIwpXk8ife0LY5RgXd9', // Dog Poop Pickup

  // Tip for Bromley — Stripe Price with custom_unit_amount (customer types any tip).
  // NOTE: Custom-amount prices cannot be optional_items; they must be line_items.
  // Customer can enter $0 (or the minimum you set in Stripe) if they prefer not to tip.
  tip: 'price_1Ts5l8IwpXk8ife01FypoJSX',
};

// Human-readable labels for metadata / receipts
const SERVICE_LABELS = {
  basic: 'Basic Mow',
  full: 'Full Yard Service',
};

/**
 * Build success / cancel URLs.
 * Prefer SITE_URL env (e.g. https://www.fieldscraft.com), otherwise use the
 * request host so Preview deployments still work.
 */
function getSiteOrigin(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Parse JSON body from Vercel / Node request.
 * Vercel often gives req.body already parsed; raw Node needs manual parse.
 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    return JSON.parse(req.body);
  }
  // Fallback: read stream (local / some runtimes)
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * CORS + JSON helpers
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  // Same-origin static site + API on Vercel; allow simple POST from our pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);

  // Browser preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // Only accept POST from the booking form
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  // Secret key must exist server-side only (Vercel env: STRIPE_SECRET_KEY)
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY environment variable');
    return sendJson(res, 500, {
      error: 'Payment system is not configured. Please try again later or text Ryan at 303.906.8597.',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    console.error('Invalid JSON body', err);
    return sendJson(res, 400, { error: 'Invalid request body. Expected JSON.' });
  }

  // ---- Pull booking fields from the form ----
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const address = String(body.address || '').trim();
  const preferredDate = String(body.preferredDate || '').trim();
  const timeWindow = String(body.timeWindow || '').trim();
  const clippingsPreference = String(body.clippingsPreference || '').trim();
  const notes = String(body.notes || '').trim();
  const serviceType = String(body.serviceType || 'basic').trim().toLowerCase();

  // Basic validation (frontend also validates; this is the safety net)
  if (!name || !phone || !email || !address || !preferredDate || !timeWindow || !clippingsPreference) {
    return sendJson(res, 400, {
      error: 'Missing required booking fields. Please complete the form and try again.',
    });
  }

  if (!PRICE_IDS[serviceType]) {
    return sendJson(res, 400, {
      error: 'Invalid service type. Choose Basic Mow or Full Yard Service.',
    });
  }

  const mainPriceId = PRICE_IDS[serviceType];
  const serviceLabel = SERVICE_LABELS[serviceType];
  const origin = getSiteOrigin(req);

  // Stripe metadata values max 500 characters each
  const metadata = {
    name: name.slice(0, 500),
    phone: phone.slice(0, 500),
    email: email.slice(0, 500),
    address: address.slice(0, 500),
    preferredDate: preferredDate.slice(0, 500),
    timeWindow: timeWindow.slice(0, 500),
    clippingsPreference: clippingsPreference.slice(0, 500),
    notes: notes.slice(0, 500),
    serviceType: serviceType,
    serviceLabel: serviceLabel,
  };

  try {
    /**
     * Create Checkout Session
     * - mode: 'payment' → one-time charge (not subscription)
     * - line_items:
     *     1) Main service (Basic Mow or Full Yard Service)
     *     2) Tip for Bromley (custom-amount Price — customer enters any tip amount)
     * - optional_items: Flower Watering + Dog Poop Pickup (toggle on Checkout)
     * - metadata: full booking details for Ryan (visible in Stripe Dashboard)
     * - customer_email: pre-fills email on Checkout
     *
     * Stripe rule: Prices with custom amounts cannot be optional_items.
     * That is why Tip is a line_item (customer sets the amount, including $0 if allowed).
     */
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [
        {
          price: mainPriceId,
          quantity: 1,
        },
        // Custom-amount tip — customer types the tip they want on Checkout
        {
          price: PRICE_IDS.tip,
          quantity: 1,
        },
      ],
      // Fixed-price optional add-ons (customer can add these on Checkout)
      optional_items: [
        {
          price: PRICE_IDS.flowerWatering,
          quantity: 1,
        },
        {
          price: PRICE_IDS.dogPoopPickup,
          quantity: 1,
        },
      ],
      metadata,
      // After successful payment → thank-you page (session_id for optional lookup later)
      success_url: `${origin}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      // If they cancel Checkout → back to booking form
      cancel_url: `${origin}/book.html?service=${encodeURIComponent(serviceType)}`,
      // Helpful note on the Checkout pay button area
      custom_text: {
        submit: {
          message:
            'Tip for Bromley is optional (enter $0 to skip if allowed). After payment, Ryan will text you within 24 hours from 303.906.8597 to confirm your exact time window.',
        },
      },
    });

    // Frontend redirects the browser to session.url
    return sendJson(res, 200, {
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error('Stripe Checkout Session error:', err);
    return sendJson(res, 500, {
      error:
        (err && err.message) ||
        'Could not start checkout. Please try again or text Ryan at 303.906.8597.',
    });
  }
};
