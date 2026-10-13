// sgc-tienda Worker
// Bot de pedidos en línea (sin WhatsApp) para tiendas
// Usa Cloudflare AI para conversar y agendar pedidos

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function jsonError(msg, status = 400) {
  return json({ error: msg }, status);
}

// JWT helpers (mismo secret que sgc-saas)
const JWT_SECRET = 'alianza58_secret_2024';

function base64urlEncode(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  return JSON.parse(atob(b64));
}
async function signJWT(payload, secret = JWT_SECRET) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + 7 * 24 * 3600 };
  const data = base64urlEncode(header) + '.' + base64urlEncode(fullPayload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function verifyJWT(token, secret = JWT_SECRET) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const data = headerB64 + '.' + payloadB64;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let sigB64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = sigB64.length % 4;
  if (pad) sigB64 += '='.repeat(4 - pad);
  const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;
  const payload = base64urlDecode(payloadB64);
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.substring(7), env.JWT_SECRET || JWT_SECRET);
}

// === System prompt para el bot de tienda ===
async function getSystemPrompt(env, tenantId, businessName) {
  let productos = [];
  let config = {};

  if (env.DB && tenantId) {
    try {
      const prodResult = await env.DB.prepare(
        'SELECT nombre, descripcion, precio, precio_oferta, categoria FROM sgc_tie_Productos WHERE activo = 1 AND tenant_id = ? ORDER BY orden, id'
      ).bind(tenantId).all();
      productos = prodResult.results || [];

      const cfgResult = await env.DB.prepare(
        'SELECT clave, valor FROM sgc_tie_Config WHERE tenant_id = ?'
      ).bind(tenantId).all();
      for (const row of cfgResult.results || []) {
        config[row.clave] = row.valor;
      }
    } catch (e) {}

    // También obtener info del tenant
    try {
      const tenant = await env.DB.prepare('SELECT business_name FROM tenants WHERE id = ?').bind(tenantId).first();
      if (tenant) businessName = tenant.business_name;
    } catch (e) {}
  }

  const botName = config.bot_name || 'BotTienda';
  const customPrompt = config.custom_prompt || '';
  const moneda = config.moneda || 'CLP';
  const metodosPago = config.metodos_pago || 'efectivo,transferencia';

  let productosText = 'No hay productos cargados aún.';
  if (productos.length > 0) {
    productosText = productos.map((p, i) =>
      `${i + 1}. ${p.nombre} - $${p.precio_oferta || p.precio} ${moneda}${p.descripcion ? ' (' + p.descripcion + ')' : ''}`
    ).join('\n');
  }

  return `Eres ${botName}, el asistente virtual de la tienda "${businessName}". Tu UNICA funcion es ayudar a los clientes a hacer pedidos de productos. NADA mas.

REGLAS:
1. Tu unica funcion es tomar pedidos de productos. NUNCA hables de otra cosa.
2. Cuando un cliente pregunte por productos, muestra la lista disponible.
3. Cuando el cliente quiera comprar, pide: nombre, telefono, direccion de entrega.
4. Confirma el pedido con el total y metodo de pago.
5. Si preguntan algo fuera de pedidos: "Mi funcion es ayudarte con tus pedidos. Que producto te interesa?"

PRODUCTOS DISPONIBLES:
${productosText}

METODOS DE PAGO: ${metodosPago}
MONEDA: ${moneda}

Cuando confirmes un pedido, responde con un JSON al final del mensaje en esta formato exacto:
[PEDIDO]{"cliente_nombre":"","cliente_telefono":"","cliente_direccion":"","productos":[{"nombre":"","cantidad":1,"precio":0}],"total":0,"metodo_pago":""}[/PEDIDO]

${customPrompt}`;
}

// === Router ===
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // === API ROUTES ===

    // GET /api/health
    if (path === '/api/health' && method === 'GET') {
      return json({ ok: true, service: 'sgc-tienda', time: new Date().toISOString() });
    }

    // POST /api/chat — Chat en línea con IA
    if (path === '/api/chat' && method === 'POST') {
      return handleChat(request, env, url);
    }

    // GET /api/products?t=:tenant — Listar productos públicos
    if (path === '/api/products' && method === 'GET') {
      return handleGetProducts(request, env, url);
    }

    // GET /api/config?t=:tenant — Config pública del bot
    if (path === '/api/config' && method === 'GET') {
      return handleGetPublicConfig(request, env, url);
    }

    // === ADMIN ROUTES (requieren auth) ===

    // POST /api/admin/login — Login admin
    if (path === '/api/admin/login' && method === 'POST') {
      return handleAdminLogin(request, env);
    }

    // GET /api/admin/tenants — Listar tenants
    if (path === '/api/admin/tenants' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleListTenants(request, env);
    }

    // POST /api/admin/toggle-bot — Habilitar/deshabilitar bot de tienda
    if (path === '/api/admin/toggle-bot' && method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleToggleBot(request, env);
    }

    // GET /api/admin/products — Listar productos del tenant
    if (path === '/api/admin/products' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleAdminGetProducts(request, env, url);
    }

    // POST /api/admin/products — Crear producto
    if (path === '/api/admin/products' && method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleCreateProduct(request, env);
    }

    // PUT /api/admin/products/:id — Editar producto
    if (path.match(/^\/api\/admin\/products\/\d+$/) && method === 'PUT') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleUpdateProduct(request, env, path);
    }

    // DELETE /api/admin/products/:id — Eliminar producto
    if (path.match(/^\/api\/admin\/products\/\d+$/) && method === 'DELETE') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleDeleteProduct(request, env, path);
    }

    // GET /api/admin/orders — Listar pedidos
    if (path === '/api/admin/orders' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleGetOrders(request, env, url);
    }

    // PATCH /api/admin/orders/:id — Actualizar estado del pedido
    if (path.match(/^\/api\/admin\/orders\/\d+$/) && method === 'PATCH') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleUpdateOrder(request, env, path);
    }

    // GET /api/admin/config — Obtener config
    if (path === '/api/admin/config' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleGetConfig(request, env, url);
    }

    // PUT /api/admin/config — Actualizar config
    if (path === '/api/admin/config' && method === 'PUT') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleUpdateConfig(request, env);
    }

    // GET /api/admin/stats — Estadísticas
    if (path === '/api/admin/stats' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleGetStats(request, env, url);
    }

    // GET /api/admin/categories — Listar categorías
    if (path === '/api/admin/categories' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleGetCategories(request, env, url);
    }

    // POST /api/admin/categories — Crear categoría
    if (path === '/api/admin/categories' && method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleCreateCategory(request, env);
    }

    // Si no es API, servir info del servicio
    if (!path.startsWith('/api/')) {
      return new Response('<html><head><meta http-equiv="refresh" content="0;url=https://sgc-tienda.pages.dev/admin"></head><body style="background:#0a0a0a;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1>SGC Tienda API</h1><p>Worker activo. <a href="https://sgc-tienda.pages.dev/admin" style="color:#22c55e">Ir al panel admin</a></p><p style="color:#666;font-size:0.8rem">Health: <a href="/api/health" style="color:#22c55e">/api/health</a></p></div></body></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    return jsonError('Endpoint no encontrado: ' + path, 404);
  }
};

// === HANDLERS ===

async function handleChat(request, env, url) {
  try {
    const body = await request.json();
    const { messages, session_id } = body;
    const tenantId = parseInt(url.searchParams.get('t') || '1');

    if (!messages || !Array.isArray(messages)) {
      return jsonError('messages es requerido (array)', 400);
    }

    // Verificar si el bot está habilitado
    const botEnabled = await env.DB.prepare(
      "SELECT valor FROM sgc_tie_Config WHERE tenant_id = ? AND clave = 'bot_enabled'"
    ).bind(tenantId).first();
    if (botEnabled && botEnabled.valor === 'false') {
      return jsonError('Bot de tienda no habilitado para este tenant', 403);
    }

    // Obtener o crear conversación
    let conversation = null;
    if (session_id) {
      conversation = await env.DB.prepare(
        'SELECT * FROM sgc_tie_ChatConversations WHERE session_id = ? AND tenant_id = ?'
      ).bind(session_id, tenantId).first();
    }
    if (!conversation) {
      const newSessionId = session_id || crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO sgc_tie_ChatConversations (tenant_id, session_id) VALUES (?, ?)'
      ).bind(tenantId, newSessionId).run();
      conversation = { id: null, session_id: newSessionId };
    }

    // Guardar mensaje del usuario
    const lastUserMsg = messages[messages.length - 1];
    if (conversation.id) {
      await env.DB.prepare(
        'INSERT INTO sgc_tie_ChatMessages (conversation_id, role, content) VALUES (?, ?, ?)'
      ).bind(conversation.id, 'user', lastUserMsg.content || lastUserMsg).run();
    } else {
      // Re-fetch para obtener el ID
      conversation = await env.DB.prepare(
        'SELECT * FROM sgc_tie_ChatConversations WHERE session_id = ?'
      ).bind(conversation.session_id).first();
      if (conversation) {
        await env.DB.prepare(
          'INSERT INTO sgc_tie_ChatMessages (conversation_id, role, content) VALUES (?, ?, ?)'
        ).bind(conversation.id, 'user', lastUserMsg.content || lastUserMsg).run();
      }
    }

    // Obtener business_name
    const tenant = await env.DB.prepare('SELECT business_name FROM tenants WHERE id = ?').bind(tenantId).first();
    const businessName = tenant?.business_name || 'Tienda';

    // Construir system prompt
    const systemPrompt = await getSystemPrompt(env, tenantId, businessName);

    // Llamar a Cloudflare AI
    let aiResponse = '';
    try {
      const aiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-10).map(m => ({
          role: m.role || 'user',
          content: typeof m === 'string' ? m : (m.content || '')
        }))
      ];

      const aiResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: aiMessages,
        max_tokens: 500,
      });
      aiResponse = aiResult.response || 'Lo siento, no pude procesar tu mensaje. Intenta de nuevo.';
    } catch (e) {
      aiResponse = 'Hola! Soy el bot de la tienda. En este momento estoy teniendo problemas tecnicos. Por favor intenta mas tarde.';
    }

    // Verificar si la respuesta contiene un pedido
    const pedidoMatch = aiResponse.match(/\[PEDIDO\](\{.*?\})\[\/PEDIDO\]/s);
    if (pedidoMatch) {
      try {
        const pedidoData = JSON.parse(pedidoMatch[1]);
        // Crear el pedido en la DB
        const total = pedidoData.productos?.reduce((sum, p) => sum + (p.precio * (p.cantidad || 1)), 0) || 0;
        const result = await env.DB.prepare(
          `INSERT INTO sgc_tie_Pedidos (tenant_id, cliente_nombre, cliente_telefono, cliente_email, cliente_direccion, cliente_referencia, productos_json, total, metodo_pago, estado, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`
        ).bind(
          tenantId,
          pedidoData.cliente_nombre || '',
          pedidoData.cliente_telefono || '',
          pedidoData.cliente_email || '',
          pedidoData.cliente_direccion || '',
          pedidoData.cliente_referencia || '',
          JSON.stringify(pedidoData.productos || []),
          total,
          pedidoData.metodo_pago || 'pendiente',
          pedidoData.observaciones || ''
        ).run();

        // Actualizar conversación con el pedido
        if (conversation) {
          await env.DB.prepare(
            'UPDATE sgc_tie_ChatConversations SET pedido_id = ?, cliente_nombre = ?, cliente_telefono = ?, updated_at = datetime(\'now\') WHERE id = ?'
          ).bind(result.meta.last_row_id, pedidoData.cliente_nombre, pedidoData.cliente_telefono, conversation.id).run();
        }

        // Limpiar el JSON del mensaje
        aiResponse = aiResponse.replace(/\[PEDIDO\].*?\[\/PEDIDO\]/s, '').trim();
      } catch (e) {
        // Si falla el parseo, enviar la respuesta tal cual
      }
    }

    // Guardar respuesta del bot
    if (conversation) {
      await env.DB.prepare(
        'INSERT INTO sgc_tie_ChatMessages (conversation_id, role, content) VALUES (?, ?, ?)'
      ).bind(conversation.id, 'assistant', aiResponse).run();

      await env.DB.prepare(
        'UPDATE sgc_tie_ChatConversations SET updated_at = datetime(\'now\') WHERE id = ?'
      ).bind(conversation.id).run();
    }

    return json({ response: aiResponse, session_id: conversation?.session_id || session_id });
  } catch (e) {
    return jsonError('Error en chat: ' + e.message, 500);
  }
}

async function handleGetProducts(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '1');
  const result = await env.DB.prepare(
    'SELECT id, nombre, descripcion, precio, precio_oferta, categoria, imagen_url, destacado FROM sgc_tie_Productos WHERE activo = 1 AND tenant_id = ? ORDER BY destacado DESC, orden, id'
  ).bind(tenantId).all();
  return json({ products: result.results || [] });
}

async function handleGetPublicConfig(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '1');
  const result = await env.DB.prepare(
    "SELECT clave, valor FROM sgc_tie_Config WHERE tenant_id = ? AND clave IN ('bot_enabled', 'bot_name', 'welcome_message', 'color_primario', 'moneda', 'bot_paused')"
  ).bind(tenantId).all();
  const config = {};
  for (const row of result.results || []) {
    config[row.clave] = row.valor;
  }
  return json({ config });
}

async function handleAdminLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return jsonError('Email y password requeridos', 400);

  const user = await env.DB.prepare('SELECT * FROM sgc_cit_AdminUsers WHERE email = ? AND activo = 1').bind(email.toLowerCase()).first();
  if (!user) return jsonError('Credenciales invalidas', 401);

  if (user.password_hash !== password) return jsonError('Credenciales invalidas', 401);

  const token = await signJWT({ id: user.id, email: user.email, role: user.role || 'admin' });
  return json({ token, user: { id: user.id, email: user.email, role: user.role || 'admin' } });
}

async function handleListTenants(request, env) {
  const result = await env.DB.prepare('SELECT id, slug, business_name, business_phone, rubro, status, created_at FROM tenants ORDER BY id').all();
  const tenants = result.results || [];

  // Obtener config de bot_enabled para cada tenant
  for (const t of tenants) {
    const cfg = await env.DB.prepare(
      "SELECT valor FROM sgc_tie_Config WHERE tenant_id = ? AND clave = 'bot_enabled'"
    ).bind(t.id).first();
    t.bot_tienda_enabled = cfg?.valor === 'true';
  }

  return json({ tenants });
}

async function handleToggleBot(request, env) {
  const { tenant_id, enabled } = await request.json();
  if (!tenant_id) return jsonError('tenant_id requerido', 400);

  await env.DB.prepare(
    "INSERT INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (?, 'bot_enabled', ?) ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ?"
  ).bind(tenant_id, enabled ? 'true' : 'false', enabled ? 'true' : 'false').run();

  return json({ success: true, tenant_id, bot_enabled: enabled });
}

async function handleAdminGetProducts(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '1');
  const result = await env.DB.prepare(
    'SELECT * FROM sgc_tie_Productos WHERE tenant_id = ? ORDER BY orden, id'
  ).bind(tenantId).all();
  return json({ products: result.results || [] });
}

async function handleCreateProduct(request, env) {
  const body = await request.json();
  const { tenant_id, nombre, descripcion, precio, precio_oferta, categoria, sku, stock, imagen_url, destacado, orden } = body;
  if (!nombre || precio === undefined) return jsonError('nombre y precio requeridos', 400);

  const result = await env.DB.prepare(
    'INSERT INTO sgc_tie_Productos (tenant_id, nombre, descripcion, precio, precio_oferta, categoria, sku, stock, imagen_url, destacado, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(tenant_id || 1, nombre, descripcion || '', precio, precio_oferta || null, categoria || 'General', sku || '', stock ?? -1, imagen_url || '', destacado ? 1 : 0, orden || 0).run();

  return json({ success: true, id: result.meta.last_row_id });
}

async function handleUpdateProduct(request, env, path) {
  const id = parseInt(path.split('/').pop());
  const body = await request.json();
  const { nombre, descripcion, precio, precio_oferta, categoria, sku, stock, imagen_url, destacado, orden, activo } = body;

  await env.DB.prepare(
    'UPDATE sgc_tie_Productos SET nombre=?, descripcion=?, precio=?, precio_oferta=?, categoria=?, sku=?, stock=?, imagen_url=?, destacado=?, orden=?, activo=?, updated_at=datetime(\'now\') WHERE id=?'
  ).bind(nombre, descripcion || '', precio, precio_oferta || null, categoria || 'General', sku || '', stock ?? -1, imagen_url || '', destacado ? 1 : 0, orden || 0, activo !== false ? 1 : 0, id).run();

  return json({ success: true });
}

async function handleDeleteProduct(request, env, path) {
  const id = parseInt(path.split('/').pop());
  await env.DB.prepare('DELETE FROM sgc_tie_Productos WHERE id=?').bind(id).run();
  return json({ success: true });
}

async function handleGetOrders(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '0');
  let query = 'SELECT * FROM sgc_tie_Pedidos';
  let params = [];
  if (tenantId > 0) {
    query += ' WHERE tenant_id = ?';
    params.push(tenantId);
  }
  query += ' ORDER BY id DESC LIMIT 100';
  const stmt = env.DB.prepare(query);
  if (params.length) stmt.bind(...params);
  const result = await stmt.all();
  return json({ orders: result.results || [] });
}

async function handleUpdateOrder(request, env, path) {
  const id = parseInt(path.split('/').pop());
  const body = await request.json();
  const { estado, estado_aprobacion, metodo_pago, observaciones, motivo_rechazo } = body;

  const updates = [];
  const values = [];
  if (estado) { updates.push('estado = ?'); values.push(estado); }
  if (estado_aprobacion) { updates.push('estado_aprobacion = ?'); values.push(estado_aprobacion); }
  if (metodo_pago) { updates.push('metodo_pago = ?'); values.push(metodo_pago); }
  if (observaciones !== undefined) { updates.push('observaciones = ?'); values.push(observaciones); }
  if (motivo_rechazo !== undefined) { updates.push('motivo_rechazo = ?'); values.push(motivo_rechazo); }
  updates.push("updated_at = datetime('now')");
  values.push(id);

  if (updates.length > 1) {
    await env.DB.prepare('UPDATE sgc_tie_Pedidos SET ' + updates.join(', ') + ' WHERE id = ?').bind(...values).run();
  }
  return json({ success: true });
}

async function handleGetConfig(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '1');
  const result = await env.DB.prepare('SELECT clave, valor FROM sgc_tie_Config WHERE tenant_id = ?').bind(tenantId).all();
  const config = {};
  for (const row of result.results || []) {
    config[row.clave] = row.valor;
  }
  return json({ config, tenant_id: tenantId });
}

async function handleUpdateConfig(request, env) {
  const { tenant_id, config } = await request.json();
  if (!tenant_id || !config) return jsonError('tenant_id y config requeridos', 400);

  for (const [clave, valor] of Object.entries(config)) {
    await env.DB.prepare(
      "INSERT INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (?, ?, ?) ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = ?"
    ).bind(tenant_id, clave, String(valor), String(valor)).run();
  }
  return json({ success: true });
}

async function handleGetStats(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '0');
  let where = '';
  let params = [];
  if (tenantId > 0) { where = 'WHERE tenant_id = ?'; params.push(tenantId); }

  const totalOrders = await env.DB.prepare(`SELECT COUNT(*) as c FROM sgc_tie_Pedidos ${where}`).bind(...params).first();
  const pendingOrders = await env.DB.prepare(`SELECT COUNT(*) as c FROM sgc_tie_Pedidos ${where ? where + ' AND' : 'WHERE'} estado = 'pendiente'`).bind(...params).first();
  const totalProducts = await env.DB.prepare(`SELECT COUNT(*) as c FROM sgc_tie_Productos ${where}`).bind(...params).first();
  const totalRevenue = await env.DB.prepare(`SELECT COALESCE(SUM(total), 0) as c FROM sgc_tie_Pedidos ${where ? where + ' AND' : 'WHERE'} estado_aprobacion = 'aprobada'`).bind(...params).first();

  return json({
    total_orders: totalOrders?.c || 0,
    pending_orders: pendingOrders?.c || 0,
    total_products: totalProducts?.c || 0,
    total_revenue: totalRevenue?.c || 0,
  });
}

async function handleGetCategories(request, env, url) {
  const tenantId = parseInt(url.searchParams.get('t') || '1');
  const result = await env.DB.prepare('SELECT * FROM sgc_tie_Categorias WHERE tenant_id = ? ORDER BY orden, id').bind(tenantId).all();
  return json({ categories: result.results || [] });
}

async function handleCreateCategory(request, env) {
  const { tenant_id, nombre, icono, orden } = await request.json();
  if (!nombre) return jsonError('nombre requerido', 400);
  try {
    const result = await env.DB.prepare(
      'INSERT INTO sgc_tie_Categorias (tenant_id, nombre, icono, orden) VALUES (?, ?, ?, ?)'
    ).bind(tenant_id || 1, nombre, icono || 'fas fa-tag', orden || 0).run();
    return json({ success: true, id: result.meta.last_row_id });
  } catch (e) {
    return jsonError('La categoria ya existe', 409);
  }
}
