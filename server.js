const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// In-memory job store
// NOTE: On serverless platforms (like Vercel), this memory is ephemeral. 
// For production use on Vercel, use a database (Redis/Postgres) to store job state.
const jobs = {};

// Rotating User Agents
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/118.0"
];

const runRequest = async (id, config) => {
    const startTime = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 10000);

    let targetUrl = config.url;
    if (config.cacheBusting) {
        const separator = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${separator}_stress=${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }

    const headers = {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...config.headers
    };

    const options = {
        method: config.method,
        headers,
        signal: controller.signal
    };

    if (config.method === 'POST' && config.payloadSizeKB > 0) {
        options.body = 'A'.repeat(config.payloadSizeKB * 1024);
        options.headers['Content-Type'] = 'text/plain';
    }

    try {
        // Node.js 18+ has native fetch.
        const response = await fetch(targetUrl, options);
        const endTime = performance.now();
        clearTimeout(timeout);

        // Extract headers
        const extractedHeaders = {};
        if (response.headers && response.headers.forEach) {
            response.headers.forEach((val, key) => {
                extractedHeaders[key.toLowerCase()] = val;
            });
        }
        
        const serverTiming = response.headers ? response.headers.get('server-timing') : null;

        try { await response.text(); } catch(e) {}

        return {
            id,
            startTime,
            duration: endTime - startTime,
            status: response.status,
            type: 'cors',
            success: response.ok,
            headers: extractedHeaders,
            serverTiming
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            id,
            startTime,
            duration: performance.now() - startTime,
            status: 0,
            type: 'error',
            success: false,
            error: err.message
        };
    }
};

app.post('/api/jobs', (req, res) => {
    const config = req.body;
    const jobId = Math.random().toString(36).substring(7);
    
    console.log(`[Job ${jobId}] Starting: ${config.url} (${config.iterations} iter)`);

    jobs[jobId] = {
        id: jobId,
        config,
        status: 'RUNNING',
        results: [],
        progress: 0,
        resultCursor: 0
    };

    (async () => {
        const job = jobs[jobId];
        const batchSize = config.concurrency || 10;
        
        for (let i = 0; i < config.iterations; i += batchSize) {
            const count = Math.min(batchSize, config.iterations - i);
            const promises = [];
            
            for (let j = 0; j < count; j++) {
                promises.push(runRequest(i + j, config));
            }

            const batchResults = await Promise.all(promises);
            job.results.push(...batchResults);
            job.progress += count;
            
            await new Promise(r => setTimeout(r, 10));
        }
        
        job.status = 'COMPLETED';
        console.log(`[Job ${jobId}] Completed.`);
    })().catch(err => {
        console.error(`[Job ${jobId}] Failed:`, err);
        if (jobs[jobId]) {
            jobs[jobId].status = 'FAILED';
            jobs[jobId].error = err.message;
        }
    });

    res.json({ jobId });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const newResults = job.results.slice(job.resultCursor);
    job.resultCursor = job.results.length;
    res.json({
        status: job.status,
        progress: job.progress,
        total: job.config.iterations,
        newResults: newResults,
        error: job.error,
        allResults: job.status === 'COMPLETED' ? job.results : undefined
    });
});

app.get('/', (req, res) => {
    res.send('StressPro Backend is running. Use /api/jobs to start a test.');
});

// Export app for Vercel/Serverless
module.exports = app;

// Start server if run directly (node server.js)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`StressPro Backend running on http://localhost:${PORT}`);
    });
}
