-- Create the integration-test database alongside the dev database.
SELECT 'CREATE DATABASE heydoc_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'heydoc_test')\gexec
