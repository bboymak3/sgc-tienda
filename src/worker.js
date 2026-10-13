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
  const waNumber = config.whatsapp_number || '';
  const waEnabled = config.whatsapp_enabled === 'true';

  let productosText = 'No hay productos cargados aún.';
  if (productos.length > 0) {
    // NO listar todos los productos si son muchos. Solo mostrar resumen por categoria.
    if (productos.length <= 8) {
      productosText = productos.map((p, i) =>
        `${i + 1}. ${p.nombre} - $${p.precio_oferta || p.precio} ${moneda}`
      ).join('\n');
    } else {
      // Resumen por categoria
      const categorias = {};
      for (const p of productos) {
        const cat = p.categoria || 'General';
        if (!categorias[cat]) categorias[cat] = [];
        categorias[cat].push(p);
      }
      const catSummary = Object.entries(categorias).map(([cat, items]) => {
        const precios = items.map(p => p.precio_oferta || p.precio);
        const minP = Math.min(...precios);
        const maxP = Math.max(...precios);
        return `${cat}: ${items.length} productos ($${minP} - $${maxP} ${moneda})`;
      }).join('\n');
      productosText = `Tenemos ${productos.length} productos en ${Object.keys(categorias).length} categorias:\n${catSummary}\n\nCuando un cliente pregunte por una categoria especifica, muestra los productos de esa categoria. Cuando pregunte por un producto concreto, confirma si lo tenemos y su precio.`;
    }
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

${customPrompt}

${waEnabled && waNumber ? `Si el cliente pide hablar con una persona real, dile: "Puedes contactarnos por WhatsApp al ${waNumber} y te atenderemos directamente."` : ''}`;
}

// === Motor de chat sin IA (fallback) ===
// Procesa pedidos sin necesidad de IA, usando pattern matching
async function handleChatWithoutAI(messages, productos, config, conversation, env) {
  const lastMsg = messages[messages.length - 1];
  const userText = (typeof lastMsg === 'string' ? lastMsg : (lastMsg.content || '')).toLowerCase().trim();
  const history = messages.slice(-6).map(m => typeof m === 'string' ? m : (m.content || ''));
  const fullContext = history.join(' ').toLowerCase();

  // Productos destacados y lista
  const prodList = productos.map((p, i) => `${i + 1}. ${p.nombre} - $${p.precio_oferta || p.precio}`).join('\n');
  const prodNames = productos.map(p => p.nombre.toLowerCase());

  // Detectar si el usuario quiere pedir/hacer un pedido
  const wantsToOrder = /quiero|pedir|comprar|llevar|pedido|ordenar|necesito|dame|vendo/.test(userText);
  // Detectar si menciona un producto
  let mentionedProducts = [];
  for (const p of productos) {
    const pName = p.nombre.toLowerCase();
    // Buscar por nombre o por número
    const numMatch = new RegExp('\\b' + (productos.indexOf(p) + 1) + '\\b').test(userText);
    if (userText.includes(pName) || numMatch || (fullContext.includes(pName) && wantsToOrder)) {
      // Buscar cantidad
      let qty = 1;
      const qtyMatch = userText.match(/(\d+)\s*(?:x\s*)?(?:de\s+)?(?:un[ao]s?\s+)?/);
      if (qtyMatch && parseInt(qtyMatch[1]) <= 10) qty = parseInt(qtyMatch[1]);
      const qtyText = userText.match(/(\d+)\s*(?:un[ao]s?\s+|x\s*)/);
      if (qtyText) qty = parseInt(qtyText[1]);
      mentionedProducts.push({ ...p, cantidad: qty });
    }
  }

  // Detectar si ya dio datos de cliente
  const hasName = /me llamo|mi nombre|soy\s+\w+/i.test(fullContext) || /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(history[history.length - 1] || '');
  const hasPhone = /(\+?56)?\s?9\s?\d{4}\s?\d{4}|\+?\d{8,}/.test(fullContext);
  const hasAddress = /direccion|calle|av|avenida|pasaje|departamento|domicilio|entrega|envio/i.test(fullContext) || /(calle|av|avenida|pasaje)\s+\w+/i.test(history[history.length - 1] || '');

  // Si hay productos mencionados Y datos de cliente, crear el pedido
  if (mentionedProducts.length > 0 && hasName && hasPhone && hasAddress) {
    // Extraer datos del contexto
    let clienteNombre = 'Cliente';
    const nameMatch = fullContext.match(/(?:me llamo|mi nombre es|soy)\s+([a-záéíóúñ\s]+)/i);
    if (nameMatch) clienteNombre = nameMatch[1].trim().substring(0, 50);

    let clienteTelefono = '';
    const phoneMatch = fullContext.match(/(\+?56?\s?9\s?\d{4}\s?\d{4}|\+?\d{8,})/);
    if (phoneMatch) clienteTelefono = phoneMatch[1].replace(/\s/g, '');

    let clienteDireccion = '';
    const addrMatch = history[history.length - 1].match(/(?:direccion|calle|av|avenida|pasaje|domicilio|entrega|envio)[:\s]+([^,]+)/i);
    if (addrMatch) clienteDireccion = addrMatch[1].trim();

    const total = mentionedProducts.reduce((sum, p) => sum + (p.precio_oferta || p.precio) * p.cantidad, 0);
    const pedidoData = {
      cliente_nombre: clienteNombre,
      cliente_telefono: clienteTelefono,
      cliente_direccion: clienteDireccion,
      productos: mentionedProducts.map(p => ({ nombre: p.nombre, cantidad: p.cantidad, precio: p.precio_oferta || p.precio })),
      total: total,
      metodo_pago: 'pendiente'
    };

    // Crear el pedido en la DB
    try {
      const result = await env.DB.prepare(
        `INSERT INTO sgc_tie_Pedidos (tenant_id, cliente_nombre, cliente_telefono, cliente_direccion, productos_json, total, metodo_pago, estado, canal)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', 'chat_online')`
      ).bind(
        config.tenant_id || 1,
        pedidoData.cliente_nombre,
        pedidoData.cliente_telefono,
        pedidoData.cliente_direccion,
        JSON.stringify(pedidoData.productos),
        total,
        pedidoData.metodo_pago
      ).run();

      if (conversation) {
        await env.DB.prepare(
          'UPDATE sgc_tie_ChatConversations SET pedido_id = ?, cliente_nombre = ?, cliente_telefono = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(result.meta.last_row_id, pedidoData.cliente_nombre, pedidoData.cliente_telefono, conversation.id).run();
      }
    } catch (e) {
      console.error('Error creando pedido:', e.message);
    }

    // Confirmar al usuario
    const prodSummary = mentionedProducts.map(p => `${p.cantidad}x ${p.nombre} — $${(p.precio_oferta || p.precio) * p.cantidad}`).join('\n');
    return `¡Pedido confirmado! 🎉\n\nResumen:\n${prodSummary}\n\nTotal: $${total}\n\nGracias ${pedidoData.cliente_nombre}! Tu pedido #${result?.meta?.last_row_id || '?'} ha sido registrado. Nos pondremos en contacto al ${clienteTelefono} para coordinar la entrega y el pago.`;
  }

  // Si hay productos mencionados pero faltan datos
  if (mentionedProducts.length > 0) {
    let resp = `¡Genial! Has elegido:\n`;
    resp += mentionedProducts.map(p => `${p.cantidad}x ${p.nombre} — $${(p.precio_oferta || p.precio) * p.cantidad}`).join('\n');
    resp += `\n\nTotal: $${mentionedProducts.reduce((s, p) => s + (p.precio_oferta || p.precio) * p.cantidad, 0)}\n\n`;
    const missing = [];
    if (!hasName) missing.push('tu nombre completo');
    if (!hasPhone) missing.push('tu telefono');
    if (!hasAddress) missing.push('tu direccion de entrega');
    if (missing.length > 0) resp += `Para confirmar el pedido, necesitamos: ${missing.join(', ')}.`;
    return resp;
  }

  // Si pregunta por productos
  if (/producto|que tienen|catalogo|lista|ver|mostrar|precio|cuanto|cuales/.test(userText) || userText === 'hola' || userText.length < 10) {
    if (productos.length === 0) return 'Hola! Por el momento no tenemos productos cargados. Vuelve mas tarde.';
    let resp = 'Hola! Bienvenido a nuestra tienda. Estos son nuestros productos disponibles:\n\n';
    resp += prodList;
    resp += '\n\nPara hacer un pedido, dime el numero o nombre del producto y tu nombre, telefono y direccion de entrega.';
    if (config.whatsapp_enabled === 'true' && config.whatsapp_number) {
      resp += `\n\nSi prefieres hablar con una persona real, escribenos por WhatsApp al ${config.whatsapp_number}.`;
    }
    return resp;
  }

  // Si menciona WhatsApp o persona real
  if (/whatsapp|persona real|humano|hablar con|atencion|contacto/.test(userText)) {
    if (config.whatsapp_enabled === 'true' && config.whatsapp_number) {
      return `Puedes contactarnos por WhatsApp al ${config.whatsapp_number} y te atenderemos directamente. 😊`;
    }
    return 'Lo siento, no tenemos WhatsApp disponible en este momento. ¿Te puedo ayudar con algun producto?';
  }

  // Respuesta por defecto
  if (productos.length > 0) {
    return 'Puedo ayudarte con tus pedidos. Estos son nuestros productos:\n\n' + prodList + '\n\nDime que producto quieres y tus datos para la entrega.';
  }
  return 'Hola! Soy el bot de la tienda. Por el momento no tenemos productos disponibles. Vuelve mas tarde.';
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

    // POST /api/admin/tenants — Crear nuevo negocio
    if (path === '/api/admin/tenants' && method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return jsonError('No autorizado', 401);
      return handleCreateTenant(request, env);
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

    // Verificar si el bot está pausado
    const botPaused = await env.DB.prepare(
      "SELECT valor FROM sgc_tie_Config WHERE tenant_id = ? AND clave = 'bot_paused'"
    ).bind(tenantId).first();
    if (botPaused && botPaused.valor === 'true') {
      return jsonError('El bot esta temporalmente pausado. Vuelve mas tarde.', 503);
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

    // Obtener config de IA del tenant directamente
    const cfgResult = await env.DB.prepare(
      'SELECT clave, valor FROM sgc_tie_Config WHERE tenant_id = ?'
    ).bind(tenantId).all();
    const aiConfig = {};
    for (const row of (cfgResult.results || [])) {
      aiConfig[row.clave] = row.valor;
    }

    // Obtener productos para fallback
    let productosList = [];
    try {
      const prodResult = await env.DB.prepare(
        'SELECT nombre, precio, precio_oferta FROM sgc_tie_Productos WHERE activo = 1 AND tenant_id = ? ORDER BY orden, id'
      ).bind(tenantId).all();
      productosList = prodResult.results || [];
    } catch (e) {}

    // Llamar a IA: Cloudflare AI o Anthropic Claude
    let aiResponse = '';
    let aiWorked = false;
    try {
      const aiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-10).map(m => ({
          role: m.role || 'user',
          content: typeof m === 'string' ? m : (m.content || '')
        }))
      ];

      const aiProvider = aiConfig.ai_provider || 'cloudflare';
      const aiModel = aiConfig.ai_model || '@cf/meta/llama-3.1-8b-instruct';
      const anthropicKey = aiConfig.anthropic_api_key || '';

      if (aiProvider === 'anthropic' && anthropicKey) {
        // Usar Anthropic Claude
        const claudeModel = aiModel || 'claude-3-haiku-20240307';
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: claudeModel,
            max_tokens: 500,
            system: systemPrompt,
            messages: messages.slice(-10).map(m => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: typeof m === 'string' ? m : (m.content || '')
            }))
          })
        });
        const claudeData = await response.json();
        aiResponse = claudeData.content?.[0]?.text || 'Lo siento, no pude procesar tu mensaje.';
        aiWorked = true;
      } else {
        // Usar Cloudflare AI (default)
        const aiResult = await env.AI.run(aiModel, {
          messages: aiMessages,
          max_tokens: 500,
        });
        if (aiResult && aiResult.response) {
          aiResponse = aiResult.response;
          aiWorked = true;
        }
      }
    } catch (e) {
      console.error('AI Error:', e.message || e.toString || JSON.stringify(e));
    }

    // Si la IA no funciono, usar motor de pedidos sin IA
    if (!aiWorked) {
      aiResponse = await handleChatWithoutAI(messages, productosList, aiConfig, conversation, env);
    }

    // Verificar si la respuesta contiene un pedido con formato [PEDIDO]
    const pedidoMatch = aiResponse.match(/\[PEDIDO\](\{.*?\})\[\/PEDIDO\]/s);
    if (pedidoMatch) {
      try {
        const pedidoData = JSON.parse(pedidoMatch[1]);
        const total = pedidoData.productos?.reduce((sum, p) => sum + (p.precio * (p.cantidad || 1)), 0) || 0;
        const result = await env.DB.prepare(
          `INSERT INTO sgc_tie_Pedidos (tenant_id, cliente_nombre, cliente_telefono, cliente_email, cliente_direccion, cliente_referencia, productos_json, total, metodo_pago, estado, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`
        ).bind(
          tenantId, pedidoData.cliente_nombre || '', pedidoData.cliente_telefono || '',
          pedidoData.cliente_email || '', pedidoData.cliente_direccion || '', pedidoData.cliente_referencia || '',
          JSON.stringify(pedidoData.productos || []), total, pedidoData.metodo_pago || 'pendiente', pedidoData.observaciones || ''
        ).run();
        if (conversation) {
          await env.DB.prepare('UPDATE sgc_tie_ChatConversations SET pedido_id = ?, cliente_nombre = ?, cliente_telefono = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .bind(result.meta.last_row_id, pedidoData.cliente_nombre, pedidoData.cliente_telefono, conversation.id).run();
        }
        aiResponse = aiResponse.replace(/\[PEDIDO\].*?\[\/PEDIDO\]/s, '').trim();
      } catch (e) {}
    }

    // Si la IA respondió pero NO generó [PEDIDO], intentar detectar pedido por contexto
    if (aiWorked && !pedidoMatch) {
      const fullContext = messages.map(m => typeof m === 'string' ? m : (m.content || '')).join(' ').toLowerCase();
      // Detectar si la IA confirma un pedido
      const isConfirming = /confirmado|confirmad|tu pedido|pedido esta|registrad|agendad|hemos registr|procesad/.test(aiResponse.toLowerCase());
      if (isConfirming) {
        // Extraer datos del contexto de la conversación
        let clienteNombre = '';
        const nameMatch = fullContext.match(/(?:me llamo|mi nombre es|soy)\s+([a-záéíóúñ\s]+)/i);
        if (nameMatch) clienteNombre = nameMatch[1].trim().substring(0, 50);

        let clienteTelefono = '';
        const phoneMatch = fullContext.match(/(\+?56?\s?9\s?\d{4}\s?\d{4}|\+?\d{8,})/);
        if (phoneMatch) clienteTelefono = phoneMatch[1].replace(/\s/g, '');

        let clienteDireccion = '';
        const addrMatch = fullContext.match(/(?:direccion|calle|av|avenida|pasaje|domicilio|entrega|envio)[:\s]+([^,\n]+)/i);
        if (addrMatch) clienteDireccion = addrMatch[1].trim();

        // Detectar productos mencionados
        let detectedProducts = [];
        for (const p of productosList) {
          const pName = p.nombre.toLowerCase();
          if (fullContext.includes(pName)) {
            let qty = 1;
            const qtyRegex = new RegExp('(\\d+)\\s*(?:x\\s*)?(?:de\\s+)?' + pName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            const qtyMatch = fullContext.match(qtyRegex);
            if (qtyMatch) qty = parseInt(qtyMatch[1]);
            detectedProducts.push({ nombre: p.nombre, cantidad: qty, precio: p.precio_oferta || p.precio });
          }
        }

        // Solo crear el pedido si tenemos al menos nombre y teléfono
        if (clienteNombre && clienteTelefono && detectedProducts.length > 0) {
          const total = detectedProducts.reduce((sum, p) => sum + p.precio * p.cantidad, 0);
          // Detectar metodo de pago
          let metodoPago = 'pendiente';
          if (/efectivo/.test(fullContext)) metodoPago = 'efectivo';
          else if (/transferencia/.test(fullContext)) metodoPago = 'transferencia';
          else if (/transbank|webpay|tarjeta/.test(fullContext)) metodoPago = 'transbank';

          try {
            const result = await env.DB.prepare(
              `INSERT INTO sgc_tie_Pedidos (tenant_id, cliente_nombre, cliente_telefono, cliente_direccion, productos_json, total, metodo_pago, estado, canal)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', 'chat_online')`
            ).bind(tenantId, clienteNombre, clienteTelefono, clienteDireccion, JSON.stringify(detectedProducts), total, metodoPago).run();

            if (conversation) {
              await env.DB.prepare('UPDATE sgc_tie_ChatConversations SET pedido_id = ?, cliente_nombre = ?, cliente_telefono = ?, updated_at = datetime(\'now\') WHERE id = ?')
                .bind(result.meta.last_row_id, clienteNombre, clienteTelefono, conversation.id).run();
            }
            console.log('Pedido creado desde IA:', result.meta.last_row_id);
          } catch (e) {
            console.error('Error creando pedido desde IA:', e.message);
          }
        }
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
  const { email, password, username } = await request.json();
  const loginUser = username || email;
  if (!loginUser || !password) return jsonError('Usuario y password requeridos', 400);

  // Buscar por username (sgc_cit_AdminUsers usa username, no email)
  const user = await env.DB.prepare('SELECT * FROM sgc_cit_AdminUsers WHERE username = ? AND activo = 1').bind(loginUser.trim().toLowerCase()).first();
  if (!user) return jsonError('Credenciales invalidas', 401);

  // Verificar password: puede ser texto plano o SHA-256
  let valid = false;
  if (user.password_hash && user.password_hash.startsWith('$2b$')) {
    valid = false; // bcrypt no implementado
  } else if (user.password_hash.length === 64) {
    // SHA-256
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    valid = (hashHex === user.password_hash);
  } else {
    // Texto plano
    valid = (user.password_hash === password);
  }
  if (!valid) return jsonError('Credenciales invalidas', 401);

  const token = await signJWT({ id: user.id, username: user.username, role: user.rol || 'admin' }, env.JWT_SECRET || JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, role: user.rol || 'admin' } });
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

async function handleCreateTenant(request, env) {
  try {
    const body = await request.json();
    const { business_name, slug, rubro, whatsapp_number } = body;

    if (!business_name || !slug) {
      return jsonError('business_name y slug son requeridos', 400);
    }

    // Verificar que el slug no exista
    const existing = await env.DB.prepare('SELECT id FROM tenants WHERE slug = ?').bind(slug.trim().toLowerCase()).first();
    if (existing) {
      return jsonError('Ya existe un negocio con ese slug', 409);
    }

    // Crear el tenant
    const result = await env.DB.prepare(
      'INSERT INTO tenants (slug, business_name, rubro, status, ai_provider, pais, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      slug.trim().toLowerCase(),
      business_name.trim(),
      rubro || 'taller',
      'active',
      'cloudflare',
      'CL',
      'America/Santiago'
    ).run();

    const tenantId = result.meta.last_row_id;

    // Crear config inicial para el bot de tienda
    const defaultConfig = [
      ['bot_enabled', 'false'],
      ['bot_name', 'BotTienda'],
      ['welcome_message', 'Hola! Bienvenido a ' + business_name.trim() + '. En que puedo ayudarte?'],
      ['custom_prompt', ''],
      ['metodos_pago', 'efectivo,transferencia,transbank'],
      ['moneda', 'CLP'],
      ['color_primario', '#22c55e'],
      ['ai_provider', 'cloudflare'],
      ['ai_model', '@cf/meta/llama-3.1-8b-instruct'],
      ['bot_paused', 'false'],
      ['whatsapp_enabled', whatsapp_number ? 'true' : 'false'],
      ['whatsapp_number', whatsapp_number || ''],
      ['whatsapp_message', 'Hola, quiero hablar con una persona real'],
    ];

    for (const [clave, valor] of defaultConfig) {
      await env.DB.prepare(
        'INSERT INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (?, ?, ?)'
      ).bind(tenantId, clave, valor).run();
    }

    // Crear categoria por defecto
    await env.DB.prepare(
      'INSERT INTO sgc_tie_Categorias (tenant_id, nombre, icono, orden) VALUES (?, ?, ?, ?)'
    ).bind(tenantId, 'General', 'fas fa-tag', 0).run();

    return json({
      success: true,
      id: tenantId,
      message: 'Negocio creado correctamente. Bot de tienda desactivado por defecto.',
      chat_url: 'https://sgc-tienda.pages.dev/chat?t=' + tenantId,
      admin_url: 'https://sgc-tienda.pages.dev/admin',
    });
  } catch (e) {
    return jsonError('Error al crear negocio: ' + e.message, 500);
  }
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
