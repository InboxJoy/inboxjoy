UPDATE suppressions
SET email_hash = encode(sha256(normalized_email::bytea), 'hex')
WHERE email_hash = '';
