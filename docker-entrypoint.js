#!/usr/bin/env node
/**
 * Docker entrypoint with optional proxy support
 * Patches global.fetch before loading the worker bundle
 */

const { ProxyAgent, fetch: undiciFetch } = require('undici');

// Get proxy URL from environment
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY_URL;

if (PROXY_URL) {
  // Hide password in logs
  const sanitizedUrl = PROXY_URL.replace(/:\/\/[^:]+:/, '://***:');
  console.log('[Proxy] Enabled with:', sanitizedUrl);
  
  const dispatcher = new ProxyAgent(PROXY_URL);
  
  // Override global fetch
  global.fetch = async function(resource, options = {}) {
    try {
      const response = await undiciFetch(resource, {
        ...options,
        dispatcher,
      });
      
      // Convert undici response to standard Web API Response
      return new global.Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new global.Headers(Object.fromEntries(response.headers.entries())),
      });
    } catch (error) {
      console.error('[Proxy] Fetch failed:', error.message);
      throw error;
    }
  };
  
  console.log('[Proxy] Global fetch patched successfully');
}

// Now start wrangler
const { spawn } = require('child_process');

const wrangler = spawn('wrangler', ['dev', '--local', '--ip', '0.0.0.0', '--port', '8787'], {
  stdio: 'inherit',
  shell: false,
});

wrangler.on('exit', (code) => {
  process.exit(code);
});
