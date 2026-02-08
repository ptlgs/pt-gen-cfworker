#!/usr/bin/env node
/**
 * Simple Node.js server for PT-Gen
 * Runs the worker code directly without wrangler/workerd
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Setup proxy if configured
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY_URL;
if (PROXY_URL) {
  const tunnel = require('tunnel');
  const https = require('https');
  const http = require('http');
  
  // Parse proxy URL
  const proxyUrl = new URL(PROXY_URL);
  const proxyHost = proxyUrl.hostname;
  const proxyPort = parseInt(proxyUrl.port) || 80;
  const proxyAuth = proxyUrl.username && proxyUrl.password 
    ? `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
    : undefined;
  
  const sanitizedUrl = PROXY_URL.replace(/:\/\/[^:]+:/, '://***:');
  console.log('[Proxy] Enabled with:', sanitizedUrl);
  console.log('[Proxy] Host:', proxyHost, 'Port:', proxyPort);
  console.log('[Proxy] Auth present:', !!proxyAuth);
  
  // Create tunnel agents for HTTP and HTTPS
  const tunnelOptions = {
    proxy: {
      host: proxyHost,
      port: proxyPort,
    }
  };
  if (proxyAuth) {
    tunnelOptions.proxy.proxyAuth = proxyAuth;
  }
  
  const httpsAgent = tunnel.httpsOverHttp(tunnelOptions);
  const httpAgent = tunnel.httpOverHttp(tunnelOptions);
  
  // Override global fetch to use proxy agent
  global.fetch = async function(resource, options = {}) {
    const startTime = Date.now();
    console.log(`[Fetch] ${options.method || 'GET'} ${resource}`);
    
    return new Promise((resolve, reject) => {
      const url = new URL(resource);
      const isHttps = url.protocol === 'https:';
      
      // Build request options
      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: isHttps ? httpsAgent : httpAgent,
      };
      
      const client = isHttps ? https : http;
      
      const req = client.request(requestOptions, (res) => {
        console.log(`[Fetch] Response: ${res.statusCode} ${res.statusMessage}`);
        console.log(`[Fetch] Headers:`, JSON.stringify(res.headers));
        
        let data = '';
        let dataLength = 0;
        
        res.on('data', chunk => {
          data += chunk;
          dataLength += chunk.length;
        });
        
        res.on('end', () => {
          const duration = Date.now() - startTime;
          console.log(`[Fetch] Completed in ${duration}ms, received ${dataLength} bytes`);
          
          if (dataLength === 0) {
            console.warn(`[Fetch] Warning: Empty response body`);
          }
          
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: {
              get: (name) => res.headers[name.toLowerCase()],
              entries: () => Object.entries(res.headers),
            },
            text: () => Promise.resolve(data),
            json: () => Promise.resolve(JSON.parse(data)),
            clone: function() { return this; },
          });
        });
      });
      
      req.on('error', (err) => {
        console.error(`[Fetch] Error:`, err.message);
        reject(err);
      });
      
      req.on('timeout', () => {
        console.error(`[Fetch] Timeout`);
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  };
  
  console.log('[Proxy] Fetch patched successfully');
}

// Simple in-memory cache
const memoryCache = new Map();

// Web API polyfills
global.Response = class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.headers = init.headers || {};
  }
  async text() { return typeof this.body === 'string' ? this.body : JSON.stringify(this.body); }
  async json() { return typeof this.body === 'string' ? JSON.parse(this.body) : this.body; }
  clone() { return new Response(this.body, { status: this.status, headers: this.headers }); }
};

global.Headers = class Headers {
  constructor(init = {}) {
    this._headers = new Map();
    if (typeof init === 'object') {
      for (const [key, value] of Object.entries(init)) {
        this._headers.set(key.toLowerCase(), value);
      }
    }
  }
  get(name) { return this._headers.get(name.toLowerCase()); }
  set(name, value) { this._headers.set(name.toLowerCase(), value); }
  entries() { return this._headers.entries(); }
};

global.URLSearchParams = class URLSearchParams {
  constructor(init = '') {
    this._params = new Map();
    if (typeof init === 'string' && init.startsWith('?')) {
      init = init.slice(1);
    }
    if (typeof init === 'string') {
      for (const pair of init.split('&')) {
        const [key, value] = pair.split('=').map(decodeURIComponent);
        if (key) this._params.set(key, value || '');
      }
    }
  }
  get(name) { return this._params.get(name) || null; }
  has(name) { return this._params.has(name); }
};

// KV Store polyfill
global.PT_GEN_STORE = {
  get: async (key) => {
    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      memoryCache.delete(key);
      return null;
    }
    return item.value;
  },
  put: async (key, value, options = {}) => {
    const ttl = options.expirationTtl || 86400;
    memoryCache.set(key, { value, expiry: Date.now() + (ttl * 1000) });
  }
};

// Load AUTHOR from env
globalThis.AUTHOR = process.env.AUTHOR || 'Rhilip';

// Load dependencies
const cheerio = require('cheerio');
const { HTML2BBCode } = require('html2bbcode');

// Inline common.js
const NONE_EXIST_ERROR = "The corresponding resource does not exist.";

function page_parser(responseText) {
  return cheerio.load(responseText, { decodeEntities: false });
}

function jsonp_parser(responseText) {
  try {
    responseText = responseText.replace(/\n/ig, '').match(/[^(]+\((.+)\)/)[1];
    return JSON.parse(responseText);
  } catch (e) {
    return {};
  }
}

function html2bbcode(html) {
  const converter = new HTML2BBCode();
  return converter.feed(html).toString();
}

async function restoreFromKV(cache_key) {
  if (global.PT_GEN_STORE) {
    const data = await PT_GEN_STORE.get(cache_key);
    return data ? JSON.parse(data) : null;
  }
}

function makeJsonRawResponse(body, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status: headers.status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...headers.headers,
    },
  });
}

const VERSION = "0.6.4";

function makeJsonResponse(body_update, statusCode = 200) {
  const default_body = {
    success: false,
    error: null,
    format: "",
    copyright: `Powered by @${globalThis.AUTHOR}`,
    version: VERSION,
    generate_at: 0,
  };
  
  const body = { ...default_body, ...body_update, generate_at: Date.now() };
  return makeJsonRawResponse(body, { status: statusCode });
}

// Douban challenge solver
async function solveChallenge(cha, difficulty = 4) {
  const crypto = require('crypto');
  const target = '0'.repeat(difficulty);
  let nonce = 0;
  
  while (true) {
    const hash = crypto.createHash('sha512').update(cha + nonce).digest('hex');
    if (hash.substring(0, difficulty) === target) return nonce;
    nonce++;
    if (nonce > 500000) throw new Error('Challenge timeout');
  }
}

async function solveDoubanChallenge(responseUrl, responseText) {
  if (!responseText.includes('process(cha)') || !responseText.includes('id="cha"')) {
    return { solved: false, text: responseText };
  }
  
  console.log('Douban challenge detected, solving...');
  
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
  
  const sol = await solveChallenge(cha, 4);
  console.log(`Challenge solved with nonce: ${sol}`);
  
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
  
  const cookies = submitResp.headers.get('set-cookie');
  const location = submitResp.headers.get('location');
  
  if (!cookies) {
    return { solved: false, text: responseText, error: 'No cookies received' };
  }
  
  const finalResp = await fetch(location || red, {
    headers: {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://sec.douban.com/',
    },
  });
  
  return { solved: true, text: await finalResp.text(), cookies };
}

// Douban module
async function search_douban(query) {
  const fetch_init = {};
  const search_url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query)}`;
  const resp = await fetch(search_url, fetch_init);
  let text = await resp.text();
  
  const challenge = await solveDoubanChallenge(resp.url || search_url, text);
  if (challenge.solved) text = challenge.text;
  
  try {
    const data = JSON.parse(text);
    return {
      data: data.map(d => ({
        year: d.year,
        subtype: d.type,
        title: d.title,
        subtitle: d.sub_title,
        link: `https://movie.douban.com/subject/${d.id}/`,
      })),
    };
  } catch (e) {
    return { 
      error: "Failed to parse search results",
      debug_info: {
        response_preview: text.substring(0, 2000),
        parse_error: e.message,
      }
    };
  }
}

async function gen_douban(sid) {
  console.log(`[Douban] Fetching movie ${sid}...`);
  const data = { site: "douban", sid };
  const douban_link = `https://movie.douban.com/subject/${sid}/`;
  
  let resp = await fetch(douban_link);
  console.log(`[Douban] Initial response status: ${resp.status}`);
  
  let text = await resp.text();
  console.log(`[Douban] Initial response length: ${text.length}`);
  
  const challenge = await solveDoubanChallenge(resp.url || douban_link, text);
  console.log(`[Douban] Challenge solved: ${challenge.solved}`);
  
  if (challenge.solved) {
    text = challenge.text;
    console.log(`[Douban] Using challenge response, length: ${text.length}`);
    if (challenge.cookies) {
      console.log(`[Douban] Re-fetching with cookies...`);
      resp = await fetch(douban_link, {
        headers: { 'Cookie': challenge.cookies, 'User-Agent': 'Mozilla/5.0' }
      });
      text = await resp.text();
      console.log(`[Douban] Re-fetch response length: ${text.length}`);
    }
  }
  
  if (text.includes('你想访问的页面不存在')) {
    console.log(`[Douban] Movie not found`);
    return { ...data, error: NONE_EXIST_ERROR };
  }
  if (text.includes('检测到有异常请求')) {
    console.log(`[Douban] Temporarily banned`);
    return { ...data, error: "GenHelp was temporary banned by Douban" };
  }
  
  console.log(`[Douban] Parsing HTML...`);
  const $ = page_parser(text);
  const title = $("title").text().replace("(豆瓣)", "").trim();
  console.log(`[Douban] Page title: "${title}"`);
  
  const ldScript = $('script[type="application/ld+json"]').html();
  console.log(`[Douban] Found ld+json script: ${!!ldScript}`);
  
  if (!ldScript) {
    console.log(`[Douban] ERROR: Could not find movie data`);
    return { 
      ...data, 
      error: "Could not find movie data",
      debug_info: {
        final_url: resp.url || douban_link,
        title: title,
        has_challenge: text.includes('process(cha)'),
        page_length: text.length,
        page_preview: text.substring(0, 2000),
      }
    };
  }
  
  let ld_json;
  try {
    ld_json = JSON.parse(ldScript.replace(/(\r\n|\n|\r|\t)/gm, ''));
  } catch (e) {
    return { 
      ...data, 
      error: "Failed to parse movie data",
      debug_info: {
        final_url: resp.url || douban_link,
        title: title,
        ld_script_preview: ldScript.substring(0, 1000),
        parse_error: e.message,
      }
    };
  }
  
  const fetch_anchor = (anchor) => anchor[0]?.nextSibling?.nodeValue?.trim() || '';
  
  let imdb_id, imdb_link, imdb_rating;
  const imdb_anchor = $('#info span.pl:contains("IMDb")');
  if (imdb_anchor.length > 0) {
    imdb_id = fetch_anchor(imdb_anchor);
    imdb_link = `https://www.imdb.com/title/${imdb_id}/`;
  }
  
  const chinese_title = title;
  const foreign_title = $('span[property="v:itemreviewed"]').text().replace(chinese_title, "").trim();
  
  let aka = '';
  const aka_anchor = $('#info span.pl:contains("又名")');
  if (aka_anchor.length > 0) {
    aka = fetch_anchor(aka_anchor).split(" / ").sort((a, b) => a.localeCompare(b)).join("/");
  }
  
  let trans_title, this_title;
  if (foreign_title) {
    trans_title = chinese_title + (aka ? "/" + aka : "");
    this_title = foreign_title;
  } else {
    trans_title = aka || "";
    this_title = chinese_title;
  }
  
  const regions_anchor = $('#info span.pl:contains("制片国家/地区")');
  const language_anchor = $('#info span.pl:contains("语言")');
  const episodes_anchor = $('#info span.pl:contains("集数")');
  const duration_anchor = $('#info span.pl:contains("单集片长")');
  
  const year = " " + $("#content > h1 > span.year").text().substr(1, 4);
  const region = regions_anchor[0] ? fetch_anchor(regions_anchor).split(" / ") : [];
  const genre = $("#info span[property='v:genre']").map((i, el) => $(el).text().trim()).get();
  const language = language_anchor[0] ? fetch_anchor(language_anchor).split(" / ") : [];
  const playdate = $("#info span[property='v:initialReleaseDate']")
    .map((i, el) => $(el).text().trim()).get()
    .sort((a, b) => new Date(a) - new Date(b));
  const episodes = episodes_anchor[0] ? fetch_anchor(episodes_anchor) : "";
  const duration = duration_anchor[0] ? fetch_anchor(duration_anchor) : $("#info span[property='v:runtime']").text().trim();
  
  const intro_el = $('#link-report-intra > span.all.hidden, #link-report-intra > [property="v:summary"], #link-report > span.all.hidden, #link-report > [property="v:summary"]');
  const introduction = intro_el.length > 0 
    ? intro_el.text().split('\n').map(a => a.trim()).filter(a => a.length > 0).join('\n')
    : '暂无相关剧情介绍';
  
  const douban_average_rating = ld_json.aggregateRating?.ratingValue || 0;
  const douban_votes = ld_json.aggregateRating?.ratingCount || 0;
  const douban_rating = `${douban_average_rating}/10 from ${douban_votes} users`;
  
  const poster = ld_json.image
    ? ld_json.image.replace(/s(_ratio_poster|pic)/g, "l$1").replace("img3", "img1")
    : "";
  
  const director = ld_json.director || [];
  const writer = ld_json.author || [];
  const cast = ld_json.actor || [];
  
  const tags = $('div.tags-body > a[href^="/tag"]').map((i, el) => $(el).text()).get();
  
  // Generate format
  let descr = poster ? `[img]${poster}[/img]\n\n` : "";
  descr += trans_title ? `◎译　　名　${trans_title}\n` : "";
  descr += this_title ? `◎片　　名　${this_title}\n` : "";
  descr += year ? `◎年　　代　${year.trim()}\n` : "";
  descr += region.length ? `◎产　　地　${region.join(" / ")}\n` : "";
  descr += genre.length ? `◎类　　别　${genre.join(" / ")}\n` : "";
  descr += language.length ? `◎语　　言　${language.join(" / ")}\n` : "";
  descr += playdate.length ? `◎上映日期　${playdate.join(" / ")}\n` : "";
  descr += imdb_rating ? `◎IMDb评分  ${imdb_rating}\n` : "";
  descr += imdb_link ? `◎IMDb链接  ${imdb_link}\n` : "";
  descr += douban_rating ? `◎豆瓣评分　${douban_rating}\n` : "";
  descr += douban_link ? `◎豆瓣链接　${douban_link}\n` : "";
  descr += episodes ? `◎集　　数　${episodes}\n` : "";
  descr += duration ? `◎片　　长　${duration}\n` : "";
  descr += director.length ? `◎导　　演　${director.map(x => x.name).join(" / ")}\n` : "";
  descr += writer.length ? `◎编　　剧　${writer.map(x => x.name).join(" / ")}\n` : "";
  descr += cast.length ? `◎主　　演　${cast.map(x => x.name).join("\n" + "　".repeat(4) + "  　").trim()}\n` : "";
  descr += tags.length ? `\n◎标　　签　${tags.join(" | ")}\n` : "";
  descr += introduction ? `\n◎简　　介\n\n　　${introduction.replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";
  
  return {
    ...data,
    success: true,
    format: descr.trim(),
    chinese_title,
    foreign_title,
    aka: aka ? aka.split("/") : [],
    trans_title: trans_title.split("/"),
    this_title: this_title.split("/"),
    year,
    region,
    genre,
    language,
    playdate,
    episodes,
    duration,
    introduction,
    douban_rating_average: douban_average_rating,
    douban_votes,
    douban_rating,
    poster,
    director,
    writer,
    cast,
    tags,
    imdb_id,
    imdb_link,
  };
}

// IMDb module
async function search_imdb(query) {
  query = query.toLowerCase();
  const resp = await fetch(`https://v2.sg.media-imdb.com/suggestion/${query.slice(0, 1)}/${query}.json`);
  const data = await resp.json();
  
  return {
    data: (data.d || [])
      .filter(d => /^tt/.test(d.id))
      .map(d => ({
        year: d.y,
        subtype: d.q,
        title: d.l,
        link: `https://www.imdb.com/title/${d.id}`,
      })),
  };
}

async function gen_imdb(sid) {
  const data = { site: "imdb", sid };
  
  if (sid.startsWith("tt")) sid = sid.slice(2);
  const imdb_id = "tt" + sid.padStart(7, "0");
  const imdb_url = `https://www.imdb.com/title/${imdb_id}/`;
  
  const resp = await fetch(imdb_url);
  const text = await resp.text();
  
  if (text.includes('404 Error - IMDb')) {
    return { ...data, error: NONE_EXIST_ERROR };
  }
  
  const $ = page_parser(text);
  const page_json = JSON.parse($('script[type="application/ld+json"]').html().replace(/\n/ig, ''));
  
  data.imdb_id = imdb_id;
  data.imdb_link = imdb_url;
  data.name = page_json.name;
  data.genre = page_json.genre;
  data.contentRating = page_json.contentRating;
  data.datePublished = page_json.datePublished;
  data.description = page_json.description;
  data.duration = page_json.duration;
  data.poster = page_json.image;
  data.year = page_json.datePublished?.slice(0, 4);
  
  if (page_json.aggregateRating) {
    data.imdb_votes = page_json.aggregateRating.ratingCount || 0;
    data.imdb_rating_average = page_json.aggregateRating.ratingValue || 0;
    data.imdb_rating = `${data.imdb_rating_average}/10 from ${data.imdb_votes} users`;
  }
  
  // Generate format
  let descr = data.poster ? `[img]${data.poster}[/img]\n\n` : "";
  descr += data.name ? `Title: ${data.name}\n` : "";
  descr += data.datePublished ? `Date Published: ${data.datePublished}\n` : "";
  descr += data.imdb_rating ? `IMDb Rating: ${data.imdb_rating}\n` : "";
  descr += data.imdb_link ? `IMDb Link: ${data.imdb_link}\n` : "";
  
  data.format = descr.trim();
  data.success = true;
  return data;
}

// Bangumi module
async function search_bangumi(query) {
  const tp_dict = { 1: "漫画/小说", 2: "动画/二次元番", 3: "音乐", 4: "游戏", 6: "三次元番" };
  const resp = await fetch(`http://api.bgm.tv/search/subject/${encodeURIComponent(query)}?responseGroup=large`);
  const data = await resp.json();
  
  return {
    data: (data.list || []).map(d => ({
      year: d.air_date?.slice(0, 4),
      subtype: tp_dict[d.type],
      title: d.name_cn || d.name,
      subtitle: d.name,
      link: d.url,
    })),
  };
}

async function gen_bangumi(sid) {
  const data = { site: "bangumi", sid };
  const bangumi_link = `https://bgm.tv/subject/${sid}`;
  
  const resp = await fetch(bangumi_link);
  const text = await resp.text();
  
  if (text.includes('呜咕，出错了')) {
    return { ...data, error: NONE_EXIST_ERROR };
  }
  
  const $ = page_parser(text);
  data.alt = bangumi_link;
  data.poster = $("div#bangumiInfo a.thickbox.cover").attr("href")
    ? "https:" + $("div#bangumiInfo a.thickbox.cover").attr("href").replace(/\/cover\/[lcmsg]\//, "/cover/l/")
    : "";
  data.story = $("div#subject_summary").text().trim();
  
  const info = $("div#bangumiInfo ul#infobox li").map((i, el) => $(el).text()).get();
  data.staff = info.filter(d => !/^(中文名|话数|放送开始|放送星期|别名|官方网站)/.test(d));
  data.info = info.filter(d => data.staff.includes(d));
  
  data.bangumi_votes = $('span[property="v:votes"]').text();
  data.bangumi_rating_average = $('div.global_score > span[property="v:average"]').text();
  data.tags = $('#subject_detail > div.subject_tag_section > div > a > span').map((i, el) => $(el).text()).get();
  
  // Generate format
  let descr = data.poster ? `[img]${data.poster}[/img]\n\n` : "";
  descr += data.story ? `[b]Story: [/b]\n\n${data.story}\n\n` : "";
  descr += data.staff?.length ? `[b]Staff: [/b]\n\n${data.staff.slice(0, 15).join("\n")}\n\n` : "";
  descr += data.alt ? `(来源于 ${data.alt})\n` : "";
  
  data.format = descr.trim();
  data.success = true;
  return data;
}

// Steam module
async function gen_steam(sid) {
  const data = { site: "steam", sid };
  
  const resp = await fetch(`https://store.steampowered.com/app/${sid}/?l=schinese`, {
    redirect: "manual",
    headers: {
      "Cookie": "lastagecheckage=1-January-1975; birthtime=157737601; mature_content=1; wants_mature_content=1; Steam_Language=schinese"
    }
  });
  
  if (resp.status === 302) return { ...data, error: NONE_EXIST_ERROR };
  if (resp.status === 403) return { ...data, error: "Steam Server ban" };
  
  const text = await resp.text();
  const $ = page_parser(text);
  
  data.name = $("div.apphub_AppName").text().trim() || $("span[itemprop='name']").text().trim();
  data.poster = $("img.game_header_image_full[src]").attr("src")?.replace(/\?t=\d+$/, "");
  data.tags = $("a.app_tag").map((i, el) => $(el).text().trim()).get();
  
  let descr = data.poster ? `[img]${data.poster}[/img]\n\n` : "";
  descr += data.name ? `游戏名称: ${data.name}\n` : "";
  descr += `Steam页面: https://store.steampowered.com/app/${sid}/\n`;
  
  data.format = descr.trim();
  data.success = true;
  return data;
}

// Indienova module
async function gen_indienova(sid) {
  const data = { site: "indienova", sid };
  const resp = await fetch(`https://indienova.com/game/${sid}`);
  const text = await resp.text();
  
  if (text.includes('出现错误')) return { ...data, error: NONE_EXIST_ERROR };
  
  const $ = page_parser(text);
  data.poster = $("div.cover-image img").attr("src");
  data.chinese_title = $("title").text().split("|")[0].split("-")[0].trim();
  
  let descr = data.poster ? `[img]${data.poster}[/img]\n\n` : "";
  descr += data.chinese_title ? `中文名称：${data.chinese_title}\n` : "";
  
  data.format = descr.trim();
  data.success = true;
  return data;
}

// Epic module
async function gen_epic(sid) {
  const data = { site: "epic", sid };
  const resp = await fetch(`https://store-content.ak.epicgames.com/api/zh-CN/content/products/${sid}`);
  
  if (resp.status === 404) return { ...data, error: NONE_EXIST_ERROR };
  
  const api_json = await resp.json();
  const page = api_json.pages?.[0];
  
  if (!page) return { ...data, error: "Invalid response" };
  
  data.name = page.productName;
  data.epic_link = `https://www.epicgames.com/store/zh-CN/product/${sid}/home`;
  data.desc = page.data?.about?.description;
  data.poster = page.data?.hero?.logoImage?.src;
  data.screenshot = (page.data?.gallery?.galleryImages || []).map(x => x.src);
  
  let descr = data.poster ? `[img]${data.poster}[/img]\n\n` : "";
  descr += data.name ? `游戏名称：${data.name}\n` : "";
  descr += data.epic_link ? `商店链接：${data.epic_link}\n` : "";
  descr += data.desc ? `\n【游戏简介】\n\n${data.desc}\n` : "";
  
  data.format = descr.trim();
  data.success = true;
  return data;
}

// Error handler
function debug_get_err(err, request) {
  return {
    message: err.name + ': ' + err.message,
    timestamp: Date.now() / 1000,
    request: request ? { method: request.method, url: request.url } : undefined,
  };
}

// Support list
const support_list = {
  "douban": /(?:https?:\/\/)?(?:(?:movie|www)\.)?douban\.com\/(?:subject|movie)\/(\d+)\/?/,
  "imdb": /(?:https?:\/\/)?(?:www\.)?imdb\.com\/title\/(tt\d+)\/?/,
  "bangumi": /(?:https?:\/\/)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)\/?/,
  "steam": /(?:https?:\/\/)?(?:store\.)?steam(?:powered|community)\.com\/app\/(\d+)\/?/,
  "indienova": /(?:https?:\/\/)?indienova\.com\/game\/(\S+)/,
  "epic": /(?:https?:\/\/)?www\.epicgames\.com\/store\/[a-zA-Z-]+\/product\/(\S+)\/\S?/
};

// Load index.html
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Main handler
async function handle(request) {
  const uri = url.parse(request.url, true);
  
  try {
    // Root path - serve HTML
    if (uri.pathname === '/' && !uri.search) {
      return new Response(indexHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // API key check
    if (process.env.APIKEY && uri.query.apikey !== process.env.APIKEY) {
      return makeJsonRawResponse({ error: 'apikey required.' }, { status: 403 });
    }
    
    let response_data;
    let cache_key;
    
    // Search endpoint
    if (uri.query.search) {
      if (process.env.DISABLE_SEARCH) {
        response_data = { error: "this ptgen disallow search" };
      } else {
        const keywords = uri.query.search;
        const source = uri.query.source || 'douban';
        cache_key = `search-${source}-${keywords}`;
        
        const cache_data = await restoreFromKV(cache_key);
        if (cache_data) {
          response_data = cache_data;
        } else if (source === 'douban') {
          response_data = await search_douban(keywords);
        } else if (source === 'imdb') {
          response_data = await search_imdb(keywords);
        } else if (source === 'bangumi') {
          response_data = await search_bangumi(keywords);
        } else {
          response_data = { error: "Unknown source: " + source };
        }
      }
    } else {
      // Generate endpoint
      let site, sid;
      
      if (uri.query.url) {
        const url_str = uri.query.url;
        for (const [site_name, pattern] of Object.entries(support_list)) {
          const match = url_str.match(pattern);
          if (match) {
            site = site_name;
            sid = match[1];
            break;
          }
        }
      } else {
        site = uri.query.site;
        sid = uri.query.sid;
      }
      
      if (!site || !sid) {
        response_data = { error: "Miss key of site or sid, or input unsupported resource url." };
      } else {
        cache_key = `info-${site}-${sid}`;
        
        const cache_data = await restoreFromKV(cache_key);
        if (cache_data) {
          response_data = cache_data;
        } else if (site === 'douban') {
          response_data = await gen_douban(sid);
        } else if (site === 'imdb') {
          response_data = await gen_imdb(sid);
        } else if (site === 'bangumi') {
          response_data = await gen_bangumi(sid);
        } else if (site === 'steam') {
          response_data = await gen_steam(sid);
        } else if (site === 'indienova') {
          response_data = await gen_indienova(sid);
        } else if (site === 'epic') {
          response_data = await gen_epic(sid);
        } else {
          response_data = { error: "Unknown site: " + site };
        }
      }
    }
    
    // Cache and return response
    if (response_data) {
      const response = makeJsonResponse(response_data);
      if (global.PT_GEN_STORE && !response_data.error && cache_key) {
        await PT_GEN_STORE.put(cache_key, JSON.stringify(response_data), { expirationTtl: 86400 * 2 });
      }
      return response;
    }
    
  } catch (err) {
    console.error('Error:', err);
    return makeJsonResponse({
      error: `Internal Error: ${err.message}`,
      debug: debug_get_err(err, request),
    }, 500);
  }
}

// Create HTTP server
const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'Access-Control-Allow-Headers, Origin,Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers'
    });
    res.end();
    return;
  }
  
  // Parse query string
  const parsed = url.parse(req.url, true);
  
  // Create request object
  const request = {
    url: req.url,
    method: req.method,
    headers: req.headers,
    searchParams: new URLSearchParams(parsed.query),
  };
  
  try {
    const response = await handle(request);
    
    res.writeHead(response.status, {
      'Content-Type': response.headers['Content-Type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    
    const body = await response.text();
    res.end(body);
  } catch (err) {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`PT-Gen server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);
  if (PROXY_URL) {
    console.log(`Proxy: ${PROXY_URL.replace(/:\/\/[^:]+:/, '://***:')}`);
  }
});
