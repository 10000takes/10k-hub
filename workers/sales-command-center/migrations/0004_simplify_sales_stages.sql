-- Collapse legacy pipeline stages into the four current stages.
-- Qualified/Nurture/Contact Identified map to New because these records have
-- not necessarily had outreach sent. Proposal/Negotiation map to Proposal Sent.
UPDATE sales_records
SET stage = CASE stage
  WHEN 'Discovered' THEN 'New'
  WHEN 'Qualified' THEN 'New'
  WHEN 'Nurture' THEN 'New'
  WHEN 'Contact Identified' THEN 'New'
  WHEN 'Outreach Sent' THEN 'Contacted'
  WHEN 'Conversation Started' THEN 'Contacted'
  WHEN 'Meeting Scheduled' THEN 'Contacted'
  WHEN 'Proposal' THEN 'Proposal Sent'
  WHEN 'Proposal Sent' THEN 'Proposal Sent'
  WHEN 'Negotiation' THEN 'Proposal Sent'
  WHEN 'Closed Won' THEN 'Closed'
  WHEN 'Closed Lost' THEN 'Closed'
  ELSE stage
END
WHERE entity_type = 'lead'
  AND stage IN ('Discovered', 'Qualified', 'Nurture', 'Contact Identified',
                'Outreach Sent', 'Conversation Started', 'Meeting Scheduled',
                'Proposal', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost');

-- Keep the lead JSON in sync with the indexed stage column.
UPDATE sales_records
SET data_json = json_set(data_json, '$.stage', CASE json_extract(data_json, '$.stage')
  WHEN 'Discovered' THEN 'New'
  WHEN 'Qualified' THEN 'New'
  WHEN 'Nurture' THEN 'New'
  WHEN 'Contact Identified' THEN 'New'
  WHEN 'Outreach Sent' THEN 'Contacted'
  WHEN 'Conversation Started' THEN 'Contacted'
  WHEN 'Meeting Scheduled' THEN 'Contacted'
  WHEN 'Proposal' THEN 'Proposal Sent'
  WHEN 'Proposal Sent' THEN 'Proposal Sent'
  WHEN 'Negotiation' THEN 'Proposal Sent'
  WHEN 'Closed Won' THEN 'Closed'
  WHEN 'Closed Lost' THEN 'Closed'
  ELSE json_extract(data_json, '$.stage')
END)
WHERE entity_type = 'lead'
  AND json_valid(data_json)
  AND json_extract(data_json, '$.stage') IN ('Discovered', 'Qualified', 'Nurture', 'Contact Identified',
                'Outreach Sent', 'Conversation Started', 'Meeting Scheduled',
                'Proposal', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost');

-- Remove obsolete stage names from legacy stage metadata as well.
UPDATE sales_records
SET data_json = json_set(data_json, '$.previous_pipeline_stage', CASE json_extract(data_json, '$.previous_pipeline_stage')
  WHEN 'Discovered' THEN 'New'
  WHEN 'Qualified' THEN 'New'
  WHEN 'Nurture' THEN 'New'
  WHEN 'Contact Identified' THEN 'New'
  WHEN 'Outreach Sent' THEN 'Contacted'
  WHEN 'Conversation Started' THEN 'Contacted'
  WHEN 'Meeting Scheduled' THEN 'Contacted'
  WHEN 'Proposal' THEN 'Proposal Sent'
  WHEN 'Proposal Sent' THEN 'Proposal Sent'
  WHEN 'Negotiation' THEN 'Proposal Sent'
  WHEN 'Closed Won' THEN 'Closed'
  WHEN 'Closed Lost' THEN 'Closed'
  ELSE json_extract(data_json, '$.previous_pipeline_stage')
END)
WHERE entity_type = 'lead'
  AND json_valid(data_json)
  AND json_extract(data_json, '$.previous_pipeline_stage') IN ('Discovered', 'Qualified', 'Nurture', 'Contact Identified',
                'Outreach Sent', 'Conversation Started', 'Meeting Scheduled',
                'Proposal', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost');
