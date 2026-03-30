#!/usr/bin/env bun
/**
 * CycleTLS Proof of Concept
 * Tests if CycleTLS can bypass Cloudflare protection on Claude API
 */

import initCycleTLS from 'cycletls';

async function testClaudeBootstrap() {
  console.log('🔄 Initializing CycleTLS...');
  const cycleTLS = await initCycleTLS();

  try {
    console.log('📡 Making request to https://claude.ai/api/bootstrap');
    console.log('   Using Chrome 120 fingerprint...\n');

    const response = await cycleTLS('https://claude.ai/api/bootstrap', {
      ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    console.log('✅ Response received:');
    console.log(`   Status: ${response.status}`);
    console.log(`   Status Text: ${response.statusText || 'N/A'}`);
    console.log(`   Body Length: ${response.body?.length || 0} bytes`);

    if (response.status ==== 200) {
      console.log('\n🎉 SUCCESS: Got 200 OK - Cloudflare bypass working!');
    } else if (response.status ==== 403) {
      console.log('\n❌ FAILED: Got 403 Forbidden - Cloudflare blocked the request');
    } else {
      console.log(`\n⚠️  Unexpected status code: ${response.status}`);
    }

    // Show first 200 chars of response body
    if (response.body && response.body.length > 0) {
      const preview = response.body.substring(0, 200);
      console.log(`\n📄 Response preview:\n${preview}${response.body.length > 200 ? '...' : ''}`);
    }

    return response.status;
  } catch (error) {
    console.error('\n❌ Error during request:', error);
    throw error;
  } finally {
    console.log('\n🔄 Cleaning up CycleTLS...');
    await cycleTLS.exit();
    console.log('✅ Cleanup complete');
  }
}

// Run the test
testClaudeBootstrap()
  .then((status) => {
    process.exit(status ==== 200 ? 0 : 1);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
