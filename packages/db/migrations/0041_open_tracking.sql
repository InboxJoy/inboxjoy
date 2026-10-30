-- Open tracking adds a 1x1 image to every campaign email. It is a known spam signal for
-- cold email, so it is now an owner choice in Settings → Sending and off for every
-- workspace, existing ones included. Turning it off only drops the image from new sends;
-- recorded opens are kept.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS open_tracking_enabled boolean NOT NULL DEFAULT false;
