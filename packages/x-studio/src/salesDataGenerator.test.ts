import { describe, expect, it } from 'vitest';
import { generateSalesData } from '../../../examples/x-studio/src/salesData/generator';

/**
 * Tests for the sales data generator (BL-04).
 *
 * These tests verify: FK integrity, seed reproducibility, count scaling,
 * and derived field correctness.
 */
describe('generateSalesData', () => {
  it('returns all 6 data sources', () => {
    const data = generateSalesData({ seed: 1, orderCount: 10 });
    expect(data.customersSource.id).toBe('source-customers');
    expect(data.productsSource.id).toBe('source-products');
    expect(data.ordersSource.id).toBe('source-orders');
    expect(data.orderItemsSource.id).toBe('source-order-items');
    expect(data.shipmentsSource.id).toBe('source-shipments');
    expect(data.shipmentItemsSource.id).toBe('source-shipment-items');
  });

  it('generates the requested number of orders', () => {
    const data = generateSalesData({ seed: 42, orderCount: 50 });
    expect(data.ordersSource.rows).toHaveLength(50);
  });

  it('generates exactly 35 products regardless of order count', () => {
    const data = generateSalesData({ seed: 42, orderCount: 1000 });
    expect(data.productsSource.rows).toHaveLength(35);
  });

  it('scales to large order counts', () => {
    const data = generateSalesData({ seed: 42, orderCount: 1000 });
    expect(data.ordersSource.rows).toHaveLength(1000);
  });

  it('produces output identical to a second run with the same seed', () => {
    const a = generateSalesData({ seed: 99, orderCount: 30 });
    const b = generateSalesData({ seed: 99, orderCount: 30 });
    expect(a.ordersSource.rows).toEqual(b.ordersSource.rows);
    expect(a.orderItemsSource.rows).toEqual(b.orderItemsSource.rows);
    expect(a.customersSource.rows).toEqual(b.customersSource.rows);
  });

  it('produces different data with a different seed', () => {
    const a = generateSalesData({ seed: 1, orderCount: 20 });
    const b = generateSalesData({ seed: 2, orderCount: 20 });
    const aIds = a.ordersSource.rows!.map((r) => r.customerId);
    const bIds = b.ordersSource.rows!.map((r) => r.customerId);
    expect(aIds).not.toEqual(bIds);
  });

  describe('FK integrity', () => {
    it('every order.customerId references a valid customer', () => {
      const data = generateSalesData({ seed: 42, orderCount: 100 });
      const customerIds = new Set(data.customersSource.rows!.map((r) => r.id));
      for (const order of data.ordersSource.rows!) {
        expect(customerIds.has(order.customerId)).toBe(true);
      }
    });

    it('every orderItem.orderId references a valid order', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const orderIds = new Set(data.ordersSource.rows!.map((r) => r.id));
      for (const item of data.orderItemsSource.rows!) {
        expect(orderIds.has(item.orderId)).toBe(true);
      }
    });

    it('every orderItem.productId references a valid product', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const productIds = new Set(data.productsSource.rows!.map((r) => r.id));
      for (const item of data.orderItemsSource.rows!) {
        expect(productIds.has(item.productId)).toBe(true);
      }
    });

    it('every shipment.orderId references a valid order', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const orderIds = new Set(data.ordersSource.rows!.map((r) => r.id));
      for (const shipment of data.shipmentsSource.rows!) {
        expect(orderIds.has(shipment.orderId)).toBe(true);
      }
    });

    it('every shipmentItem.shipmentId references a valid shipment', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const shipmentIds = new Set(data.shipmentsSource.rows!.map((r) => r.id));
      for (const si of data.shipmentItemsSource.rows!) {
        expect(shipmentIds.has(si.shipmentId)).toBe(true);
      }
    });

    it('every shipmentItem.orderItemId references a valid orderItem', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const itemIds = new Set(data.orderItemsSource.rows!.map((r) => r.id));
      for (const si of data.shipmentItemsSource.rows!) {
        expect(itemIds.has(si.orderItemId)).toBe(true);
      }
    });

    it('all customer IDs are unique', () => {
      const data = generateSalesData({ seed: 42, orderCount: 100 });
      const ids = data.customersSource.rows!.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all order IDs are unique', () => {
      const data = generateSalesData({ seed: 42, orderCount: 200 });
      const ids = data.ordersSource.rows!.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all product IDs are unique', () => {
      const data = generateSalesData({ seed: 42, orderCount: 10 });
      const ids = data.productsSource.rows!.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('derived fields', () => {
    it('order.total equals the sum of its order items', () => {
      const data = generateSalesData({ seed: 42, orderCount: 20 });

      // Build a map of order totals from order items
      const itemTotalsByOrder = new Map<unknown, number>();
      for (const item of data.orderItemsSource.rows!) {
        const orderId = item.orderId;
        itemTotalsByOrder.set(orderId, (itemTotalsByOrder.get(orderId) ?? 0) + Number(item.total));
      }

      for (const order of data.ordersSource.rows!) {
        const expected = itemTotalsByOrder.get(order.id) ?? 0;
        // Round to 2dp to match currency rounding
        expect(Number(order.total)).toBeCloseTo(expected, 1);
      }
    });

    it('orderItem.total = quantity * unitPrice * (1 - discount/100)', () => {
      const data = generateSalesData({ seed: 42, orderCount: 10 });
      for (const item of data.orderItemsSource.rows!) {
        const qty = Number(item.quantity);
        const price = Number(item.unitPrice);
        const disc = Number(item.discount);
        const expected = Math.round(qty * price * (1 - disc / 100) * 100) / 100;
        expect(Number(item.total)).toBeCloseTo(expected, 1);
      }
    });

    it('shipment.onTime is true when actualDelivery <= estimatedDelivery', () => {
      const data = generateSalesData({ seed: 42, orderCount: 100 });
      for (const shipment of data.shipmentsSource.rows!) {
        if (shipment.actualDeliveryDate == null) {
          expect(shipment.onTime).toBe(false);
        } else {
          const onTime = String(shipment.actualDeliveryDate) <= String(shipment.estimatedDeliveryDate);
          expect(shipment.onTime).toBe(onTime);
        }
      }
    });

    it('all order dates are valid ISO date strings', () => {
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
      for (const order of data.ordersSource.rows!) {
        expect(String(order.date)).toMatch(isoPattern);
      }
    });

    it('order currency matches customer country', () => {
      const COUNTRY_CURRENCY: Record<string, string> = {
        Germany: 'EUR', France: 'EUR', Spain: 'EUR',
        Netherlands: 'EUR', Sweden: 'EUR', Poland: 'EUR',
        UK: 'GBP', USA: 'USD', Canada: 'CAD', Australia: 'AUD',
      };
      const data = generateSalesData({ seed: 42, orderCount: 50 });
      const customerById = new Map(data.customersSource.rows!.map((c) => [c.id, c]));
      for (const order of data.ordersSource.rows!) {
        const customer = customerById.get(order.customerId);
        const expectedCurrency = COUNTRY_CURRENCY[String(customer?.country)];
        expect(order.currency).toBe(expectedCurrency);
      }
    });
  });

  describe('value vocabularies', () => {
    it('order statuses are from the allowed set', () => {
      const VALID_STATUSES = new Set([
        'Delivered', 'Shipped', 'Processing', 'Pending', 'Partially Delivered', 'Cancelled',
      ]);
      const data = generateSalesData({ seed: 42, orderCount: 100 });
      for (const order of data.ordersSource.rows!) {
        expect(VALID_STATUSES.has(String(order.status))).toBe(true);
      }
    });

    it('product categories are from the allowed set', () => {
      const VALID_CATEGORIES = new Set([
        'Electronics', 'Furniture', 'Supplies', 'Software', 'Services', 'Networking',
      ]);
      const data = generateSalesData({ seed: 42, orderCount: 10 });
      for (const product of data.productsSource.rows!) {
        expect(VALID_CATEGORIES.has(String(product.category))).toBe(true);
      }
    });

    it('shipment carriers are from the allowed set', () => {
      const VALID_CARRIERS = new Set(['DHL', 'FedEx', 'UPS', 'USPS', 'DPD', 'GLS']);
      const data = generateSalesData({ seed: 42, orderCount: 100 });
      for (const shipment of data.shipmentsSource.rows!) {
        expect(VALID_CARRIERS.has(String(shipment.carrier))).toBe(true);
      }
    });
  });
});
