import {page_parser} from "./common";

/**
 * Solve Douban's SHA512 proof-of-work challenge
 * Algorithm: Find nonce where SHA512(cha + nonce) starts with difficulty zeros
 */
async function solveChallenge(cha, difficulty = 4) {
  const target = '0'.repeat(difficulty);
  const encoder = new TextEncoder();
  
  let nonce = 0;
  while (true) {
    const data = cha + nonce;
    const buffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-512', buffer.buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (hash.substring(0, difficulty) === target) {
      return nonce;
    }
    nonce++;
    
    // Safety limit - in practice should find solution within ~10000-100000 iterations
    if (nonce > 500000) {
      throw new Error('Challenge solution timeout - too many iterations');
    }
  }
}

/**
 * Check if response is a challenge page and solve it
 * Returns the final page content after solving challenge
 */
export async function solveDoubanChallenge(responseUrl, responseText) {
  // Check if this is a challenge page (contains the process function and cha input)
  if (!responseText.includes('process(cha)') || !responseText.includes('id="cha"')) {
    return { solved: false, text: responseText };
  }

  console.log('Douban challenge detected, solving...');
  
  // Extract challenge parameters - use flexible regex to handle different quote styles
  const tokMatch = responseText.match(/id=["\']tok["\'][^>]*value=["\']([^"\']+)["\']/i) || 
                   responseText.match(/value=["\']([^"\']+)["\'][^>]*id=["\']tok["\']/i);
  const chaMatch = responseText.match(/id=["\']cha["\'][^>]*value=["\']([^"\']+)["\']/i) ||
                   responseText.match(/value=["\']([^"\']+)["\'][^>]*id=["\']cha["\']/i);
  const redMatch = responseText.match(/id=["\']red["\'][^>]*value=["\']([^"\']+)["\']/i) ||
                   responseText.match(/value=["\']([^"\']+)["\'][^>]*id=["\']red["\']/i);
  
  if (!tokMatch || !chaMatch) {
    return { solved: false, text: responseText, error: 'Could not extract challenge parameters' };
  }

  const tok = tokMatch[1];
  const cha = chaMatch[1];
  const red = redMatch ? redMatch[1] : 'https://movie.douban.com/';
  
  // Solve the proof-of-work
  const sol = await solveChallenge(cha, 4);
  
  console.log(`Challenge solved with nonce: ${sol}`);
  
  // Submit the solution to sec.douban.com
  const formData = new URLSearchParams();
  formData.append('tok', tok);
  formData.append('cha', cha);
  formData.append('sol', sol.toString());
  formData.append('red', red);
  
  const submitResp = await fetch('https://sec.douban.com/c', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': responseUrl,
      'Origin': 'https://sec.douban.com',
    },
    body: formData.toString(),
    redirect: 'manual',
  });
  
  // Get cookies and redirect location
  const cookies = submitResp.headers.get('set-cookie');
  const location = submitResp.headers.get('location');
  
  if (!cookies) {
    return { solved: false, text: responseText, error: 'No cookies received from challenge submission' };
  }
  
  // Fetch the actual page with the session cookie
  const finalResp = await fetch(location || red, {
    headers: {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://sec.douban.com/',
    },
  });
  
  const finalText = await finalResp.text();
  
  return { 
    solved: true, 
    text: finalText,
    cookies: cookies,
  };
}
