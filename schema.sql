-- ============================================================
-- SGC TIENDA — Bot de pedidos en línea (sin WhatsApp)
-- Tablas con prefijo sgc_tie_ en database 'citas'
-- ============================================================

-- 1. Productos por tenant (catálogo de la tienda)
CREATE TABLE IF NOT EXISTS sgc_tie_Productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  precio INTEGER NOT NULL DEFAULT 0,
  precio_oferta INTEGER,
  categoria TEXT DEFAULT 'General',
  sku TEXT,
  stock INTEGER DEFAULT -1,
  imagen_url TEXT,
  activo INTEGER DEFAULT 1,
  destacado INTEGER DEFAULT 0,
  orden INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_prod_tenant ON sgc_tie_Productos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_prod_activo ON sgc_tie_Productos(activo);

-- 2. Pedidos (solicitudes de compra agendadas por el bot)
CREATE TABLE IF NOT EXISTS sgc_tie_Pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  cliente_nombre TEXT NOT NULL,
  cliente_telefono TEXT,
  cliente_email TEXT,
  cliente_direccion TEXT,
  cliente_referencia TEXT,
  productos_json TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  metodo_pago TEXT DEFAULT 'pendiente',
  estado TEXT DEFAULT 'pendiente',
  estado_aprobacion TEXT DEFAULT 'pendiente',
  motivo_rechazo TEXT,
  observaciones TEXT,
  canal TEXT DEFAULT 'chat_online',
  notificada_tienda INTEGER DEFAULT 0,
  notificada_cliente INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_ped_tenant ON sgc_tie_Pedidos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_ped_estado ON sgc_tie_Pedidos(estado);

-- 3. Config del bot de tienda por tenant
CREATE TABLE IF NOT EXISTS sgc_tie_Config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  clave TEXT NOT NULL,
  valor TEXT,
  UNIQUE(tenant_id, clave)
);

-- 4. Conversaciones de chat en línea
CREATE TABLE IF NOT EXISTS sgc_tie_ChatConversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  session_id TEXT NOT NULL UNIQUE,
  cliente_nombre TEXT,
  cliente_telefono TEXT,
  cliente_email TEXT,
  estado TEXT DEFAULT 'activa',
  pedido_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_chat_tenant ON sgc_tie_ChatConversations(tenant_id);

-- 5. Mensajes de chat en línea
CREATE TABLE IF NOT EXISTS sgc_tie_ChatMessages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES sgc_tie_ChatConversations(id)
);
CREATE INDEX IF NOT EXISTS idx_sgc_tie_msg_conv ON sgc_tie_ChatMessages(conversation_id);

-- 6. Categorías de productos
CREATE TABLE IF NOT EXISTS sgc_tie_Categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  nombre TEXT NOT NULL,
  icono TEXT DEFAULT 'fas fa-tag',
  orden INTEGER DEFAULT 0,
  activa INTEGER DEFAULT 1,
  UNIQUE(tenant_id, nombre)
);

-- ============================================================
-- CONFIG INICIAL
-- ============================================================
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'bot_enabled', 'false');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'bot_name', 'BotTienda');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'welcome_message', 'Hola! Bienvenido a nuestra tienda virtual. En que puedo ayudarte hoy?');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'custom_prompt', '');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'metodos_pago', 'efectivo,transferencia,transbank');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'moneda', 'CLP');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'color_primario', '#22c55e');
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'ai_provider', 'cloudflare');

-- Categorías por defecto
INSERT OR IGNORE INTO sgc_tie_Categorias (tenant_id, nombre, icono, orden) VALUES (1, 'General', 'fas fa-tag', 0);
INSERT OR IGNORE INTO sgc_tie_Config (tenant_id, clave, valor) VALUES (1, 'bot_paused', 'false');
