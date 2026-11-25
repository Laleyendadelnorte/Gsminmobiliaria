CREATE TABLE IF NOT EXISTS media_blobs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 property_id uuid NOT NULL REFERENCES properties(id),
 prefix text UNIQUE NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>=0),
 status text NOT NULL CHECK(status IN ('PROCESSING','READY','CLEANUP_REQUIRED')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_blobs_org ON media_blobs(organization_id,status);
