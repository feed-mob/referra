// bid_transactions contains line-item-matched log records with normalized column names.
export const deliveryBidMetricsSql = `
SELECT * FROM (
  WITH transactions AS (
    SELECT *, status = 200 AND (reason_category = 'bid' OR substr(reason_category, 1, 4) = 'bid:') AS offered
    FROM bid_transactions
    WHERE event_type = 'bid_transaction'
  )
  SELECT bucket_start, 'bid' AS metric_type, filter_id, line_item_id, 'ALL' AS dimension,
    0 AS impressions, 0 AS installs, 0 AS bid_requests, count(*) AS bids,
    -- Zero-price offers would drag the average down, so only positive prices are averaged.
    coalesce(avg(CASE WHEN price_usd > 0 THEN price_usd END), 0.0) AS bid_price_usd
  FROM transactions
  WHERE offered
  GROUP BY bucket_start, filter_id, line_item_id
  UNION ALL
  SELECT bucket_start, 'bid_reason' AS metric_type, filter_id, line_item_id, reason_category AS dimension,
    0 AS impressions, 0 AS installs, count(*) AS bid_requests,
    sum(CASE WHEN offered THEN 1 ELSE 0 END) AS bids, 0.0 AS bid_price_usd
  FROM transactions
  GROUP BY bucket_start, filter_id, line_item_id, reason_category
) bid_metrics`;
