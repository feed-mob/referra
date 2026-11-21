import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deliveryBidMetricsSql } from '../delivery-bid-metrics.lib';

test('counts only successful offers while retaining refusals and errors in requests', () => {
  const db = new Database(':memory:');
  try {
    const rows = db.query(`
      WITH bid_transactions(bucket_start, filter_id, line_item_id, event_type, status, reason_category, price_usd) AS (
        VALUES
          (10, 23837, '129', 'bid_transaction', 200, 'bid:conversion_model', 12.0),
          (10, 23837, '129', 'bid_transaction', 200, 'bid', 8.0),
          (10, 23837, '129', 'bid_transaction', 204, 'conversion_model_below_threshold', 0.0),
          (10, 23837, '129', 'bid_transaction', 204, 'below_floor', 0.0),
          (10, 23837, '129', 'bid_transaction', 500, 'bid:conversion_model', 12.0),
          (10, 23837, '129', 'bid_transaction', 200, 'invalid_bid', 12.0),
          (10, 23837, '129', 'request_summary', 200, 'bid', 20.0)
      )
      ${deliveryBidMetricsSql}
    `).all() as Array<{ metric_type: string; dimension: string; bids: number; bid_requests: number; bid_price_usd: number }>;
    expect(rows.filter(row => row.metric_type === 'bid')).toMatchObject([{ bids: 2, bid_price_usd: 10 }]);
    const reasons = rows.filter(row => row.metric_type === 'bid_reason');
    expect(reasons.reduce((sum, row) => sum + row.bid_requests, 0)).toBe(6);
    expect(reasons.reduce((sum, row) => sum + row.bids, 0)).toBe(2);
    expect(reasons.find(row => row.dimension === 'bid:conversion_model')).toMatchObject({ bid_requests: 2, bids: 1 });
    for (const reason of ['below_floor', 'conversion_model_below_threshold', 'invalid_bid']) {
      expect(reasons.find(row => row.dimension === reason)).toMatchObject({ bid_requests: 1, bids: 0 });
    }
  } finally {
    db.close();
  }
});
