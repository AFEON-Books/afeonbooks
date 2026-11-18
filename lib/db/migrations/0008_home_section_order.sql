ALTER TABLE site_content
  ADD COLUMN IF NOT EXISTS home_section_order text NOT NULL DEFAULT '["hero","shop","about","faq"]';

ALTER TABLE site_content
  ADD COLUMN IF NOT EXISTS home_custom_sections text NOT NULL DEFAULT '[]';
