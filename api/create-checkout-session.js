/**
 * /api/create-checkout-session
 * -----------------------------------------------------------------------------
 * Vercel serverless function that creates a Stripe Checkout Session for
 * FieldsCraft Lawn Care.
 *
 * Supports two flows:
 *
 *  A) One-time booking (book.html)
 *     - mode: 'payment'
 *     - body.serviceType: 'basic' | 'full'
 *     - optional tip via price_data + optional add-ons on Checkout
 *
 *  B) Weekly subscription (weekly.html)
 *     - mode: 'subscription'
 *     - body.formType: 'weekly'  (or body.serviceType: 'basic_weekly' | 'full_weekly')
 *     - body.serviceType / weekly_plan: 'basic' | 'full' (weekly variants)
 *     - optional recurring tip Price IDs
 *
 * SECURITY: STRIPE_SECRET_KEY is read only from process.env on the server.
 * It must NEVER be put in frontend HTML/JS.
 * -----------------------------------------------------------------------------
 */

const Stripe = require('stripe');

// ---- Live Stripe Price IDs (Dashboard → Products) ----
const PRICE_IDS = {
  // One-time main services
  basic: 'price_1TrqNmIwpXk8ife0hEw0Smla', // Basic Mow
  full: 'price_1TrqNmIwpXk8ife0jlQYnV4t', // Full Yard Service

  // Weekly recurring plans (subscription)
  basic_weekly: 'price_1TuxzEIwpXk8ife0iLcI5L4R', // Basic Weekly Mow – $18/week
  full_weekly: 'price_1TuxyXIwpXk8ife0gx9HvW6T', // Full Service Weekly Mow – $20/week

  // Weekly recurring tips (subscription line items)
  tip_weekly_3: 'price_1TuyPCIwpXk8ife0X7ncoRfK', // $3/week tip
  tip_weekly_5: 'price_1TuyPaIwpXk8ife07WXDaaJx', // $5/week tip

  // Optional one-time add-ons shown on Stripe Checkout
  flowerWatering: 'price_1Ts5ZKIwpXk8ife07lehq9P1', // Flower Watering
  dogPoopPickup: 'price_1Ts5aEIwpXk8ife0LY5RgXd9', // Dog Poop Pickup

  // Tip Price ID (custom_unit_amount) — kept for reference only.
  // Stripe does NOT allow combining a custom-amount Price with other line_items,
  // and custom-amount Prices cannot be optional_items either. So one-time tips
  // use dynamic price_data instead of this Price ID.
  // tip: 'price_1Ts5l8IwpXk8ife01FypoJSX',
};

// Human-readable labels for metadata / receipts
const SERVICE_LABELS = {
  basic: 'Basic Mow',
  full: 'Full Yard Service',
  basic_weekly: 'Basic Weekly Mow – $18/week',
  full_weekly: 'Full Service Weekly Mow – $20/week',
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

/**
 * Detect weekly subscription flow from the request body.
 * weekly.html sends formType: 'weekly' and serviceType: 'basic' | 'full'
 * (or already-qualified basic_weekly / full_weekly).
 */
function isWeeklyRequest(body) {
  const formType = String(body.formType || body.form_type || '').trim().toLowerCase();
  if (formType === 'weekly' || formType === 'weekly_signup') return true;
  const serviceType = String(body.serviceType || body.service || '').trim().toLowerCase();
  return serviceType === 'basic_weekly' || serviceType === 'full_weekly';
}

/** Resolve weekly service key: basic_weekly | full_weekly */
function resolveWeeklyServiceType(body) {
  const raw = String(body.serviceType || body.service || body.weekly_plan || 'basic')
    .trim()
    .toLowerCase();
  if (raw === 'basic_weekly' || raw === 'full_weekly') return raw;
  if (raw === 'full') return 'full_weekly';
  return 'basic_weekly';
}

/**
 * Resolve optional weekly tip amount in dollars (0 if none).
 *
 * NOTE: We intentionally do NOT attach the Dashboard tip Price IDs
 * (tip_weekly_3 / tip_weekly_5) as line_items alongside the plan Price.
 * Stripe Checkout rejects mixed billing intervals, and the $5 tip Price
 * in the Dashboard is not on the same weekly interval as the plans.
 * Instead we charge tips via price_data with recurring.interval = 'week'
 * so they always match the weekly plan cadence.
 */
function resolveWeeklyTipDollars(body) {
  // Prefer numeric tipAmount from the form
  let tipDollars = Number(body.tipAmount);
  if (Number.isFinite(tipDollars) && tipDollars > 0) {
    if (tipDollars > 500) tipDollars = 500;
    return tipDollars;
  }

  // Map known tip Price IDs from the form to dollar amounts
  const tipPriceId = String(body.tipPriceId || body.tip_price_id || '').trim();
  if (tipPriceId === PRICE_IDS.tip_weekly_5) return 5;
  if (tipPriceId === PRICE_IDS.tip_weekly_3) return 3;

  // Fall back to strings like "$3/week" or "3"
  const tipStr = String(body.weekly_tip || body.tip_amount || '').replace(/[^0-9.]/g, '');
  tipDollars = parseFloat(tipStr);
  if (!Number.isFinite(tipDollars) || tipDollars <= 0) return 0;
  if (tipDollars > 500) tipDollars = 500;
  return tipDollars;
}

async function createOneTimeSession(stripe, body, origin) {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const address = String(body.address || '').trim();
  const preferredDate = String(body.preferredDate || '').trim();
  const timeWindow = String(body.timeWindow || '').trim();
  const clippingsPreference = String(body.clippingsPreference || '').trim();
  const notes = String(body.notes || '').trim();
  const serviceType = String(body.serviceType || 'basic').trim().toLowerCase();

  // Optional tip from the booking form (dollars). Stripe custom-amount Prices cannot
  // share a session with other line_items, so we send tip as dynamic price_data.
  let tipDollars = Number(body.tipAmount);
  if (!Number.isFinite(tipDollars) || tipDollars < 0) tipDollars = 0;
  // Cap tips at $500 to avoid typos; convert to cents for Stripe
  if (tipDollars > 500) tipDollars = 500;
  const tipCents = Math.round(tipDollars * 100);

  // Basic validation (frontend also validates; this is the safety net)
  if (!name || !phone || !email || !address || !preferredDate || !timeWindow || !clippingsPreference) {
    return {
      status: 400,
      payload: {
        error: 'Missing required booking fields. Please complete the form and try again.',
      },
    };
  }

  if (serviceType !== 'basic' && serviceType !== 'full') {
    return {
      status: 400,
      payload: {
        error: 'Invalid service type. Choose Basic Mow or Full Yard Service.',
      },
    };
  }

  const mainPriceId = PRICE_IDS[serviceType];
  const serviceLabel = SERVICE_LABELS[serviceType];

  // Stripe metadata values max 500 characters each
  const metadata = {
    formType: 'one_time',
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
    tipAmount: tipDollars > 0 ? `$${tipDollars.toFixed(2)}` : 'none',
  };

  /**
   * Create Checkout Session
   * - mode: 'payment' → one-time charge (not subscription)
   * - line_items: main service (+ optional Tip for Bromley via price_data)
   * - optional_items: Flower Watering + Dog Poop Pickup (toggle on Checkout)
   * - metadata: full booking details for Ryan (visible in Stripe Dashboard)
   * - customer_email: pre-fills email on Checkout
   *
   * Why tip uses price_data (not Price ID price_1Ts5l8…):
   * Stripe only allows ONE line_item when that item is a custom_unit_amount Price,
   * and custom-amount Prices also cannot be optional_items. Dynamic price_data
   * lets us charge any tip amount alongside the main service.
   */
  const lineItems = [
    {
      price: mainPriceId,
      quantity: 1,
    },
  ];

  // Add tip only when customer chose an amount > $0 on the booking form
  if (tipCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: tipCents,
        product_data: {
          name: 'Tip for Bromley',
          description: 'Optional tip — thank you for supporting FieldsCraft!',
        },
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: lineItems,
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
          'You can add Flower Watering or Dog Poop Pickup below. After payment, Ryan will text you within 24 hours from 303.906.8597 to confirm your exact time window.',
      },
    },
  });

  return {
    status: 200,
    payload: {
      url: session.url,
      sessionId: session.id,
      mode: 'payment',
    },
  };
}

async function createWeeklySession(stripe, body, origin) {
  const name = String(body.name || body.full_name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const address = String(body.address || body.service_address || '').trim();
  const preferredDay = String(body.preferredDay || body.preferred_day || '').trim();
  const clippingsPreference = String(
    body.clippingsPreference || body.lawn_clippings || ''
  ).trim();
  const notes = String(body.notes || '').trim();
  const serviceType = resolveWeeklyServiceType(body);

  if (!name || !phone || !email || !address || !preferredDay || !clippingsPreference) {
    return {
      status: 400,
      payload: {
        error:
          'Missing required weekly signup fields. Please complete the form and try again.',
      },
    };
  }

  if (!PRICE_IDS[serviceType]) {
    return {
      status: 400,
      payload: {
        error: 'Invalid weekly plan. Choose Basic Weekly Mow or Full Service Weekly Mow.',
      },
    };
  }

  const mainPriceId = PRICE_IDS[serviceType];
  const serviceLabel = SERVICE_LABELS[serviceType];
  const tipDollars = resolveWeeklyTipDollars(body);
  const tipCents = Math.round(tipDollars * 100);

  const metadata = {
    formType: 'weekly',
    name: name.slice(0, 500),
    phone: phone.slice(0, 500),
    email: email.slice(0, 500),
    address: address.slice(0, 500),
    preferredDay: preferredDay.slice(0, 500),
    clippingsPreference: clippingsPreference.slice(0, 500),
    notes: notes.slice(0, 500),
    serviceType: serviceType,
    serviceLabel: serviceLabel,
    tipAmount: tipDollars > 0 ? `$${tipDollars.toFixed(2)}/week` : 'none',
  };

  // Subscription Checkout: main weekly plan + optional weekly tip
  const lineItems = [
    {
      price: mainPriceId,
      quantity: 1,
    },
  ];

  // Optional tip as matching weekly recurring price_data (avoids mixed intervals)
  if (tipCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: tipCents,
        recurring: { interval: 'week' },
        product_data: {
          name: 'Weekly tip for Bromley',
          description: 'Optional weekly tip — thank you for supporting Bromley!',
        },
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: lineItems,
    metadata,
    // Also attach metadata to the subscription object for later lookup
    subscription_data: {
      metadata,
      description: serviceLabel,
    },
    // After successful payment → same thank-you page as one-time bookings
    success_url: `${origin}/thank-you.html?session_id={CHECKOUT_SESSION_ID}&type=weekly`,
    // If they cancel Checkout → back to weekly page
    cancel_url: `${origin}/weekly.html`,
    custom_text: {
      submit: {
        message:
          'After you subscribe, Ryan will text you from 303.906.8597 to confirm Bromley’s first weekly time window. Cancel anytime.',
      },
    },
  });

  return {
    status: 200,
    payload: {
      url: session.url,
      sessionId: session.id,
      mode: 'subscription',
    },
  };
}

module.exports = async function handler(req, res) {
  setCors(res);

  // Browser preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // Only accept POST from booking / weekly forms
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

  const origin = getSiteOrigin(req);

  try {
    const result = isWeeklyRequest(body)
      ? await createWeeklySession(stripe, body, origin)
      : await createOneTimeSession(stripe, body, origin);

    return sendJson(res, result.status, result.payload);
  } catch (err) {
    console.error('Stripe Checkout Session error:', err);
    return sendJson(res, 500, {
      error:
        (err && err.message) ||
        'Could not start checkout. Please try again or text Ryan at 303.906.8597.',
    });
  }
};
