import type { StudioDataSource } from '../../../../packages/x-studio/src';

// ============================================================================
// Products
// ============================================================================
export const PRODUCTS_SOURCE_ID = 'source-products';

export const productsSource: StudioDataSource = {
  id: PRODUCTS_SOURCE_ID,
  label: 'Products',
  fields: [
    { id: 'id', label: 'Product ID', type: 'string' },
    { id: 'name', label: 'Product Name', type: 'string' },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'price', label: 'Unit Price', type: 'number' },
    { id: 'cost', label: 'Unit Cost', type: 'number' },
    { id: 'stock', label: 'In Stock', type: 'number' },
    { id: 'reorderLevel', label: 'Reorder Level', type: 'number' },
  ],
  rows: [
    { id: 'PRD-001', name: 'Laptop Pro 15"', category: 'Electronics', price: 1299, cost: 850, stock: 45, reorderLevel: 20 },
    { id: 'PRD-002', name: 'Wireless Mouse', category: 'Electronics', price: 49, cost: 18, stock: 230, reorderLevel: 50 },
    { id: 'PRD-003', name: 'USB-C Hub', category: 'Electronics', price: 79, cost: 32, stock: 156, reorderLevel: 40 },
    { id: 'PRD-004', name: 'Mechanical Keyboard', category: 'Electronics', price: 149, cost: 65, stock: 88, reorderLevel: 30 },
    { id: 'PRD-005', name: 'Monitor 27" 4K', category: 'Electronics', price: 449, cost: 280, stock: 34, reorderLevel: 15 },
    { id: 'PRD-006', name: 'Office Chair Ergonomic', category: 'Furniture', price: 399, cost: 180, stock: 22, reorderLevel: 10 },
    { id: 'PRD-007', name: 'Standing Desk', category: 'Furniture', price: 599, cost: 320, stock: 18, reorderLevel: 8 },
    { id: 'PRD-008', name: 'Desk Lamp LED', category: 'Furniture', price: 69, cost: 25, stock: 95, reorderLevel: 25 },
    { id: 'PRD-009', name: 'Webcam HD', category: 'Electronics', price: 89, cost: 38, stock: 142, reorderLevel: 35 },
    { id: 'PRD-010', name: 'Headphones Noise-Cancel', category: 'Electronics', price: 299, cost: 145, stock: 67, reorderLevel: 20 },
    { id: 'PRD-011', name: 'Printer Laser', category: 'Electronics', price: 349, cost: 210, stock: 28, reorderLevel: 12 },
    { id: 'PRD-012', name: 'Paper A4 (500 sheets)', category: 'Supplies', price: 12, cost: 6, stock: 520, reorderLevel: 100 },
    { id: 'PRD-013', name: 'Ink Cartridge Black', category: 'Supplies', price: 35, cost: 12, stock: 180, reorderLevel: 40 },
    { id: 'PRD-014', name: 'Ink Cartridge Color', category: 'Supplies', price: 45, cost: 16, stock: 145, reorderLevel: 35 },
    { id: 'PRD-015', name: 'Notebook Set (3-pack)', category: 'Supplies', price: 18, cost: 7, stock: 340, reorderLevel: 80 },
    { id: 'PRD-016', name: 'Whiteboard 48x36"', category: 'Furniture', price: 129, cost: 55, stock: 15, reorderLevel: 8 },
    { id: 'PRD-017', name: 'Filing Cabinet', category: 'Furniture', price: 249, cost: 120, stock: 12, reorderLevel: 6 },
    { id: 'PRD-018', name: 'External SSD 1TB', category: 'Electronics', price: 119, cost: 65, stock: 78, reorderLevel: 25 },
    { id: 'PRD-019', name: 'Tablet 10"', category: 'Electronics', price: 449, cost: 290, stock: 42, reorderLevel: 15 },
    { id: 'PRD-020', name: 'Docking Station', category: 'Electronics', price: 199, cost: 95, stock: 56, reorderLevel: 20 },
  ],
};

export const productsBindings = productsSource.fields.map((f) => ({ field: f.id, label: f.label }));

// ============================================================================
// Customers
// ============================================================================
export const CUSTOMERS_SOURCE_ID = 'source-customers';

export const customersSource: StudioDataSource = {
  id: CUSTOMERS_SOURCE_ID,
  label: 'Customers',
  fields: [
    { id: 'id', label: 'Customer ID', type: 'string' },
    { id: 'company', label: 'Company', type: 'string' },
    { id: 'contact', label: 'Contact Name', type: 'string' },
    { id: 'email', label: 'Email', type: 'string' },
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'segment', label: 'Segment', type: 'string' },
    { id: 'since', label: 'Customer Since', type: 'string' },
  ],
  rows: [
    { id: 'CUS-001', company: 'TechCorp GmbH', contact: 'Hans Mueller', email: 'h.mueller@techcorp.de', country: 'Germany', region: 'EMEA', segment: 'Enterprise', since: '2019-03-15' },
    { id: 'CUS-002', company: 'Nordic Solutions AB', contact: 'Erik Lindqvist', email: 'erik@nordicsolutions.se', country: 'Sweden', region: 'EMEA', segment: 'Mid-Market', since: '2020-07-22' },
    { id: 'CUS-003', company: 'London Digital Ltd', contact: 'Sarah Thompson', email: 's.thompson@londondigital.co.uk', country: 'UK', region: 'EMEA', segment: 'Enterprise', since: '2018-11-08' },
    { id: 'CUS-004', company: 'Paris Tech SARL', contact: 'Marie Dubois', email: 'marie.dubois@paristech.fr', country: 'France', region: 'EMEA', segment: 'Mid-Market', since: '2021-01-30' },
    { id: 'CUS-005', company: 'Alpine Systems AG', contact: 'Thomas Brunner', email: 't.brunner@alpinesys.ch', country: 'Switzerland', region: 'EMEA', segment: 'SMB', since: '2022-04-12' },
    { id: 'CUS-006', company: 'Amsterdam Analytics BV', contact: 'Jan de Vries', email: 'jdevries@amanalytics.nl', country: 'Netherlands', region: 'EMEA', segment: 'Enterprise', since: '2019-09-05' },
    { id: 'CUS-007', company: 'Milano Design SRL', contact: 'Luca Rossi', email: 'l.rossi@milanodesign.it', country: 'Italy', region: 'EMEA', segment: 'Mid-Market', since: '2020-12-18' },
    { id: 'CUS-008', company: 'Madrid Software SL', contact: 'Carlos Garcia', email: 'cgarcia@madridsw.es', country: 'Spain', region: 'EMEA', segment: 'SMB', since: '2021-06-25' },
    { id: 'CUS-009', company: 'Dublin Data Inc', contact: 'Patrick O\'Brien', email: 'pobrien@dublindata.ie', country: 'Ireland', region: 'EMEA', segment: 'Mid-Market', since: '2020-02-14' },
    { id: 'CUS-010', company: 'Vienna Ventures GmbH', contact: 'Anna Schmidt', email: 'a.schmidt@viennaventures.at', country: 'Austria', region: 'EMEA', segment: 'SMB', since: '2022-08-30' },
    { id: 'CUS-011', company: 'Brussels Consulting', contact: 'Jean Dupont', email: 'jdupont@brusselsconsult.be', country: 'Belgium', region: 'EMEA', segment: 'Enterprise', since: '2019-05-20' },
    { id: 'CUS-012', company: 'Copenhagen Cloud ApS', contact: 'Lars Nielsen', email: 'lars@copenhagencloud.dk', country: 'Denmark', region: 'EMEA', segment: 'Mid-Market', since: '2021-10-07' },
    { id: 'CUS-013', company: 'Helsinki Tech Oy', contact: 'Mikko Virtanen', email: 'mikko@helsinkitech.fi', country: 'Finland', region: 'EMEA', segment: 'SMB', since: '2022-01-19' },
    { id: 'CUS-014', company: 'Oslo Innovations AS', contact: 'Kristin Berg', email: 'k.berg@osloinnovations.no', country: 'Norway', region: 'EMEA', segment: 'Enterprise', since: '2018-08-11' },
    { id: 'CUS-015', company: 'Warsaw Digital Sp', contact: 'Piotr Kowalski', email: 'pkowalski@warsawdigital.pl', country: 'Poland', region: 'EMEA', segment: 'Mid-Market', since: '2021-03-28' },
  ],
};

export const customersBindings = customersSource.fields.map((f) => ({ field: f.id, label: f.label }));

// ============================================================================
// Orders (denormalized with product and customer info for easier visualization)
// ============================================================================
export const ORDERS_SOURCE_ID = 'source-orders';

export const ordersSource: StudioDataSource = {
  id: ORDERS_SOURCE_ID,
  label: 'Orders',
  fields: [
    { id: 'id', label: 'Order ID', type: 'string' },
    { id: 'date', label: 'Order Date', type: 'string' },
    { id: 'customerId', label: 'Customer ID', type: 'string' },
    { id: 'company', label: 'Company', type: 'string' },
    { id: 'country', label: 'Country', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'segment', label: 'Segment', type: 'string' },
    { id: 'productId', label: 'Product ID', type: 'string' },
    { id: 'product', label: 'Product', type: 'string' },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'quantity', label: 'Quantity', type: 'number' },
    { id: 'unitPrice', label: 'Unit Price', type: 'number' },
    { id: 'discount', label: 'Discount %', type: 'number' },
    { id: 'total', label: 'Total', type: 'number' },
    { id: 'status', label: 'Status', type: 'string' },
  ],
  rows: [
    { id: 'ORD-0001', date: '2024-01-05', customerId: 'CUS-001', company: 'TechCorp GmbH', country: 'Germany', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-001', product: 'Laptop Pro 15"', category: 'Electronics', quantity: 10, unitPrice: 1299, discount: 5, total: 12340.5, status: 'Delivered' },
    { id: 'ORD-0002', date: '2024-01-08', customerId: 'CUS-003', company: 'London Digital Ltd', country: 'UK', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-005', product: 'Monitor 27" 4K', category: 'Electronics', quantity: 15, unitPrice: 449, discount: 8, total: 6196.2, status: 'Delivered' },
    { id: 'ORD-0003', date: '2024-01-12', customerId: 'CUS-002', company: 'Nordic Solutions AB', country: 'Sweden', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-010', product: 'Headphones Noise-Cancel', category: 'Electronics', quantity: 25, unitPrice: 299, discount: 10, total: 6727.5, status: 'Delivered' },
    { id: 'ORD-0004', date: '2024-01-15', customerId: 'CUS-006', company: 'Amsterdam Analytics BV', country: 'Netherlands', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-019', product: 'Tablet 10"', category: 'Electronics', quantity: 20, unitPrice: 449, discount: 12, total: 7902.4, status: 'Delivered' },
    { id: 'ORD-0005', date: '2024-01-18', customerId: 'CUS-014', company: 'Oslo Innovations AS', country: 'Norway', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-007', product: 'Standing Desk', category: 'Furniture', quantity: 8, unitPrice: 599, discount: 5, total: 4552.4, status: 'Delivered' },
    { id: 'ORD-0006', date: '2024-01-22', customerId: 'CUS-004', company: 'Paris Tech SARL', country: 'France', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-004', product: 'Mechanical Keyboard', category: 'Electronics', quantity: 30, unitPrice: 149, discount: 15, total: 3799.5, status: 'Delivered' },
    { id: 'ORD-0007', date: '2024-01-25', customerId: 'CUS-011', company: 'Brussels Consulting', country: 'Belgium', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-006', product: 'Office Chair Ergonomic', category: 'Furniture', quantity: 12, unitPrice: 399, discount: 10, total: 4309.2, status: 'Delivered' },
    { id: 'ORD-0008', date: '2024-01-28', customerId: 'CUS-007', company: 'Milano Design SRL', country: 'Italy', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-002', product: 'Wireless Mouse', category: 'Electronics', quantity: 50, unitPrice: 49, discount: 20, total: 1960, status: 'Delivered' },
    { id: 'ORD-0009', date: '2024-02-02', customerId: 'CUS-005', company: 'Alpine Systems AG', country: 'Switzerland', region: 'EMEA', segment: 'SMB', productId: 'PRD-018', product: 'External SSD 1TB', category: 'Electronics', quantity: 15, unitPrice: 119, discount: 0, total: 1785, status: 'Delivered' },
    { id: 'ORD-0010', date: '2024-02-05', customerId: 'CUS-009', company: 'Dublin Data Inc', country: 'Ireland', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-011', product: 'Printer Laser', category: 'Electronics', quantity: 5, unitPrice: 349, discount: 5, total: 1657.75, status: 'Delivered' },
    { id: 'ORD-0011', date: '2024-02-08', customerId: 'CUS-012', company: 'Copenhagen Cloud ApS', country: 'Denmark', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-020', product: 'Docking Station', category: 'Electronics', quantity: 18, unitPrice: 199, discount: 8, total: 3295.44, status: 'Delivered' },
    { id: 'ORD-0012', date: '2024-02-12', customerId: 'CUS-001', company: 'TechCorp GmbH', country: 'Germany', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-009', product: 'Webcam HD', category: 'Electronics', quantity: 40, unitPrice: 89, discount: 15, total: 3026, status: 'Delivered' },
    { id: 'ORD-0013', date: '2024-02-15', customerId: 'CUS-008', company: 'Madrid Software SL', country: 'Spain', region: 'EMEA', segment: 'SMB', productId: 'PRD-003', product: 'USB-C Hub', category: 'Electronics', quantity: 20, unitPrice: 79, discount: 5, total: 1501, status: 'Delivered' },
    { id: 'ORD-0014', date: '2024-02-18', customerId: 'CUS-015', company: 'Warsaw Digital Sp', country: 'Poland', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-012', product: 'Paper A4 (500 sheets)', category: 'Supplies', quantity: 100, unitPrice: 12, discount: 25, total: 900, status: 'Delivered' },
    { id: 'ORD-0015', date: '2024-02-22', customerId: 'CUS-010', company: 'Vienna Ventures GmbH', country: 'Austria', region: 'EMEA', segment: 'SMB', productId: 'PRD-015', product: 'Notebook Set (3-pack)', category: 'Supplies', quantity: 50, unitPrice: 18, discount: 10, total: 810, status: 'Delivered' },
    { id: 'ORD-0016', date: '2024-02-25', customerId: 'CUS-003', company: 'London Digital Ltd', country: 'UK', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-001', product: 'Laptop Pro 15"', category: 'Electronics', quantity: 25, unitPrice: 1299, discount: 10, total: 29227.5, status: 'Delivered' },
    { id: 'ORD-0017', date: '2024-02-28', customerId: 'CUS-013', company: 'Helsinki Tech Oy', country: 'Finland', region: 'EMEA', segment: 'SMB', productId: 'PRD-008', product: 'Desk Lamp LED', category: 'Furniture', quantity: 15, unitPrice: 69, discount: 0, total: 1035, status: 'Delivered' },
    { id: 'ORD-0018', date: '2024-03-02', customerId: 'CUS-006', company: 'Amsterdam Analytics BV', country: 'Netherlands', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-017', product: 'Filing Cabinet', category: 'Furniture', quantity: 6, unitPrice: 249, discount: 5, total: 1419.3, status: 'Delivered' },
    { id: 'ORD-0019', date: '2024-03-05', customerId: 'CUS-002', company: 'Nordic Solutions AB', country: 'Sweden', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-016', product: 'Whiteboard 48x36"', category: 'Furniture', quantity: 4, unitPrice: 129, discount: 0, total: 516, status: 'Delivered' },
    { id: 'ORD-0020', date: '2024-03-08', customerId: 'CUS-004', company: 'Paris Tech SARL', country: 'France', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-013', product: 'Ink Cartridge Black', category: 'Supplies', quantity: 40, unitPrice: 35, discount: 15, total: 1190, status: 'Delivered' },
    { id: 'ORD-0021', date: '2024-03-11', customerId: 'CUS-014', company: 'Oslo Innovations AS', country: 'Norway', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-001', product: 'Laptop Pro 15"', category: 'Electronics', quantity: 15, unitPrice: 1299, discount: 8, total: 17926.2, status: 'Delivered' },
    { id: 'ORD-0022', date: '2024-03-14', customerId: 'CUS-011', company: 'Brussels Consulting', country: 'Belgium', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-005', product: 'Monitor 27" 4K', category: 'Electronics', quantity: 20, unitPrice: 449, discount: 10, total: 8082, status: 'Delivered' },
    { id: 'ORD-0023', date: '2024-03-18', customerId: 'CUS-007', company: 'Milano Design SRL', country: 'Italy', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-014', product: 'Ink Cartridge Color', category: 'Supplies', quantity: 30, unitPrice: 45, discount: 10, total: 1215, status: 'Shipped' },
    { id: 'ORD-0024', date: '2024-03-21', customerId: 'CUS-009', company: 'Dublin Data Inc', country: 'Ireland', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-010', product: 'Headphones Noise-Cancel', category: 'Electronics', quantity: 12, unitPrice: 299, discount: 5, total: 3408.6, status: 'Shipped' },
    { id: 'ORD-0025', date: '2024-03-24', customerId: 'CUS-005', company: 'Alpine Systems AG', country: 'Switzerland', region: 'EMEA', segment: 'SMB', productId: 'PRD-004', product: 'Mechanical Keyboard', category: 'Electronics', quantity: 8, unitPrice: 149, discount: 0, total: 1192, status: 'Shipped' },
    { id: 'ORD-0026', date: '2024-03-27', customerId: 'CUS-012', company: 'Copenhagen Cloud ApS', country: 'Denmark', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-019', product: 'Tablet 10"', category: 'Electronics', quantity: 10, unitPrice: 449, discount: 5, total: 4265.5, status: 'Shipped' },
    { id: 'ORD-0027', date: '2024-03-30', customerId: 'CUS-001', company: 'TechCorp GmbH', country: 'Germany', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-007', product: 'Standing Desk', category: 'Furniture', quantity: 15, unitPrice: 599, discount: 12, total: 7906.8, status: 'Processing' },
    { id: 'ORD-0028', date: '2024-04-02', customerId: 'CUS-015', company: 'Warsaw Digital Sp', country: 'Poland', region: 'EMEA', segment: 'Mid-Market', productId: 'PRD-002', product: 'Wireless Mouse', category: 'Electronics', quantity: 60, unitPrice: 49, discount: 18, total: 2410.8, status: 'Processing' },
    { id: 'ORD-0029', date: '2024-04-05', customerId: 'CUS-008', company: 'Madrid Software SL', country: 'Spain', region: 'EMEA', segment: 'SMB', productId: 'PRD-009', product: 'Webcam HD', category: 'Electronics', quantity: 10, unitPrice: 89, discount: 0, total: 890, status: 'Processing' },
    { id: 'ORD-0030', date: '2024-04-08', customerId: 'CUS-010', company: 'Vienna Ventures GmbH', country: 'Austria', region: 'EMEA', segment: 'SMB', productId: 'PRD-006', product: 'Office Chair Ergonomic', category: 'Furniture', quantity: 4, unitPrice: 399, discount: 5, total: 1516.2, status: 'Pending' },
    { id: 'ORD-0031', date: '2024-04-10', customerId: 'CUS-003', company: 'London Digital Ltd', country: 'UK', region: 'EMEA', segment: 'Enterprise', productId: 'PRD-020', product: 'Docking Station', category: 'Electronics', quantity: 30, unitPrice: 199, discount: 15, total: 5074.5, status: 'Pending' },
    { id: 'ORD-0032', date: '2024-04-12', customerId: 'CUS-013', company: 'Helsinki Tech Oy', country: 'Finland', region: 'EMEA', segment: 'SMB', productId: 'PRD-003', product: 'USB-C Hub', category: 'Electronics', quantity: 12, unitPrice: 79, discount: 0, total: 948, status: 'Pending' },
  ],
};

export const ordersBindings = ordersSource.fields.map((f) => ({ field: f.id, label: f.label }));
