import type { Knex } from 'knex';

/**
 * Create all tables for the Studio sales demo dataset.
 *
 * Column names match the camelCase field names produced by generateSalesData()
 * so rows can be inserted directly without any name transformation.
 *
 * Uses CREATE TABLE IF NOT EXISTS — safe to call on every startup.
 * Indexes are created separately with IF NOT EXISTS to handle partial prior runs.
 */
export async function createTables(db: Knex): Promise<void> {
  await db.schema.createTableIfNotExists('customers', (t) => {
    t.string('id').primary();
    t.string('company').notNullable();
    t.string('contact').notNullable();
    t.string('email').notNullable();
    t.string('country').notNullable();
    t.string('segment').notNullable();
    t.string('since').notNullable();
  });

  await db.schema.createTableIfNotExists('products', (t) => {
    t.string('id').primary();
    t.string('product').notNullable();
    t.string('category').notNullable();
    t.float('price').notNullable();
    t.float('cost').notNullable();
    t.integer('stock').notNullable();
    t.integer('reorderLevel').notNullable();
  });

  await db.schema.createTableIfNotExists('orders', (t) => {
    t.string('id').primary();
    t.string('date').notNullable();
    t.string('customerId').notNullable();
    t.string('status').notNullable();
    t.float('total').notNullable();
    t.string('currency').notNullable();
  });

  await db.schema.createTableIfNotExists('order_items', (t) => {
    t.string('id').primary();
    t.string('orderId').notNullable();
    t.string('productId').notNullable();
    t.string('product').notNullable();
    t.string('category').notNullable();
    t.integer('quantity').notNullable();
    t.float('unitPrice').notNullable();
    t.float('discount').notNullable();
    t.float('total').notNullable();
  });

  await db.schema.createTableIfNotExists('shipments', (t) => {
    t.string('id').primary();
    t.string('orderId').notNullable();
    t.string('carrier').notNullable();
    t.string('trackingNumber').notNullable();
    t.string('shipDate').notNullable();
    t.string('estimatedDeliveryDate').notNullable();
    t.string('actualDeliveryDate').nullable();
    t.string('status').notNullable();
    t.boolean('onTime').notNullable();
    t.integer('itemCount').notNullable();
  });

  await db.schema.createTableIfNotExists('shipment_items', (t) => {
    t.string('id').primary();
    t.string('shipmentId').notNullable();
    t.string('orderItemId').notNullable();
  });

  // Create indexes separately using IF NOT EXISTS so this is idempotent.
  const indexes: [string, string][] = [
    ['orders_customerid_index', 'CREATE INDEX IF NOT EXISTS orders_customerid_index ON orders (customerId)'],
    ['orders_date_index', 'CREATE INDEX IF NOT EXISTS orders_date_index ON orders (date)'],
    ['orders_status_index', 'CREATE INDEX IF NOT EXISTS orders_status_index ON orders (status)'],
    ['order_items_orderid_index', 'CREATE INDEX IF NOT EXISTS order_items_orderid_index ON order_items (orderId)'],
    ['order_items_productid_index', 'CREATE INDEX IF NOT EXISTS order_items_productid_index ON order_items (productId)'],
    ['order_items_category_index', 'CREATE INDEX IF NOT EXISTS order_items_category_index ON order_items (category)'],
    ['shipments_orderid_index', 'CREATE INDEX IF NOT EXISTS shipments_orderid_index ON shipments (orderId)'],
    ['shipments_status_index', 'CREATE INDEX IF NOT EXISTS shipments_status_index ON shipments (status)'],
    ['shipment_items_shipmentid_index', 'CREATE INDEX IF NOT EXISTS shipment_items_shipmentid_index ON shipment_items (shipmentId)'],
    ['shipment_items_orderitemid_index', 'CREATE INDEX IF NOT EXISTS shipment_items_orderitemid_index ON shipment_items (orderItemId)'],
  ];

  for (const [, sql] of indexes) {
    await db.raw(sql);
  }
}


/** Table names in dependency order (used for drops during reseed). */
export const TABLE_NAMES = [
  'shipment_items',
  'shipments',
  'order_items',
  'orders',
  'products',
  'customers',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
