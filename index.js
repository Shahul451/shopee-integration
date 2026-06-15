require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PARTNER_ID = Number(process.env.PARTNER_ID);
const PARTNER_KEY = process.env.PARTNER_KEY;
const BASE_URL = process.env.BASE_URL;
const REDIRECT_URL = process.env.REDIRECT_URL;

// 📂 Persistent token storage path (Azure /home/ is persistent, local uses project dir)
const TOKEN_FILE = process.env.HOME 
    ? path.join(process.env.HOME, "tokens.json")  // Azure: /home/tokens.json
    : path.join(__dirname, "tokens.json");          // Local: ./tokens.json

// 🔄 Load saved tokens on startup (survives Azure restarts)
function loadTokens() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
            if (saved.access_token) process.env.ACCESS_TOKEN = saved.access_token;
            if (saved.refresh_token) process.env.REFRESH_TOKEN = saved.refresh_token;
            if (saved.shop_id) process.env.SHOP_ID = saved.shop_id;
            console.log("✅ Loaded tokens from persistent storage.");
        }
    } catch (err) {
        console.log("⚠️ Could not load saved tokens:", err.message);
    }
}
loadTokens();

// 📝 Helper to update tokens (works on both local and Azure)
function updateEnv(newTokens) {
    // Always update process.env in memory
    if (newTokens.access_token) process.env.ACCESS_TOKEN = newTokens.access_token;
    if (newTokens.refresh_token) process.env.REFRESH_TOKEN = newTokens.refresh_token;
    if (newTokens.shop_id) process.env.SHOP_ID = newTokens.shop_id;

    // Save to persistent JSON file (works on both local and Azure)
    try {
        const tokenData = {
            access_token: process.env.ACCESS_TOKEN,
            refresh_token: process.env.REFRESH_TOKEN,
            shop_id: process.env.SHOP_ID,
            updated_at: new Date().toISOString()
        };
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
        console.log("✅ Tokens saved to persistent storage:", TOKEN_FILE);
    } catch (err) {
        console.log("⚠️ Could not save tokens to file:", err.message);
    }

    // Also try to update .env file (for local development)
    const envPath = path.join(__dirname, ".env");
    try {
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, "utf8");

            if (newTokens.access_token) {
                envContent = envContent.match(/ACCESS_TOKEN=.*/)
                    ? envContent.replace(/ACCESS_TOKEN=.*/, `ACCESS_TOKEN=${newTokens.access_token}`)
                    : envContent + `\nACCESS_TOKEN=${newTokens.access_token}`;
            }
            if (newTokens.refresh_token) {
                envContent = envContent.match(/REFRESH_TOKEN=.*/)
                    ? envContent.replace(/REFRESH_TOKEN=.*/, `REFRESH_TOKEN=${newTokens.refresh_token}`)
                    : envContent + `\nREFRESH_TOKEN=${newTokens.refresh_token}`;
            }
            if (newTokens.shop_id) {
                envContent = envContent.match(/SHOP_ID=.*/)
                    ? envContent.replace(/SHOP_ID=.*/, `SHOP_ID=${newTokens.shop_id}`)
                    : envContent + `\nSHOP_ID=${newTokens.shop_id}`;
            }

            fs.writeFileSync(envPath, envContent);
            console.log("✅ .env file updated automatically.");
        }
    } catch (err) {
        console.log("⚠️ Could not update .env file:", err.message);
    }
}

// 🔐 Generate SIGN
function generateSign(baseString) {
    return crypto.createHmac("sha256", PARTNER_KEY).update(baseString).digest("hex");
}

// 🔄 Auto-Refresh Wrapper
async function shopeeRequest(method, apiPath, params = {}, body = null) {
    const timestamp = Math.floor(Date.now() / 1000);
    const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
    const SHOP_ID = process.env.SHOP_ID;

    const baseString = `${PARTNER_ID}${apiPath}${timestamp}${ACCESS_TOKEN}${SHOP_ID}`;
    const sign = generateSign(baseString);

    const config = {
        method,
        url: `${BASE_URL}${apiPath}`,
        params: { partner_id: PARTNER_ID, timestamp, access_token: ACCESS_TOKEN, shop_id: SHOP_ID, sign, ...params }
    };
    if (body) config.data = body;

    try {
        return await axios(config);
    } catch (err) {
        if (err.response?.status === 403) {
            console.log("🔄 Token expired. Attempting auto-refresh...");
            const newTokens = await refreshAccessToken();
            if (newTokens) {
                console.log("🚀 Retrying original request with new token...");
                return await shopeeRequest(method, apiPath, params, body);
            }
        }
        throw err;
    }
}

async function refreshAccessToken() {
    try {
        const path = "/api/v2/auth/access_token/get";
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

        const res = await axios.post(`${BASE_URL}${path}`, 
            { refresh_token: process.env.REFRESH_TOKEN, shop_id: Number(process.env.SHOP_ID), partner_id: PARTNER_ID },
            { params: { partner_id: PARTNER_ID, timestamp, sign } }
        );

        if (res.data.access_token) {
            updateEnv({ access_token: res.data.access_token, refresh_token: res.data.refresh_token });
            return res.data;
        }
    } catch (err) {
        console.error("❌ Auto-refresh failed:", err.response?.data || err.message);
        return null;
    }
}

///////////////////////////////////////////////////////////
// 🚀 AUTHENTICATION
///////////////////////////////////////////////////////////
app.get("/auth", (req, res) => {
    const path = "/api/v2/shop/auth_partner";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);
    res.redirect(`${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${REDIRECT_URL}`);
});

app.get("/callback", async (req, res) => {
    try {
        const { code, shop_id } = req.query;
        console.log("📥 Callback received - code:", code, "shop_id:", shop_id);
        
        const path = "/api/v2/auth/token/get";
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

        console.log("🔑 Requesting token from Shopee...");
        const response = await axios.post(`${BASE_URL}${path}`, 
            { code, shop_id: Number(shop_id), partner_id: PARTNER_ID },
            { params: { partner_id: PARTNER_ID, timestamp, sign } }
        );

        console.log("✅ Token response:", JSON.stringify(response.data));
        updateEnv({ access_token: response.data.access_token, refresh_token: response.data.refresh_token, shop_id: shop_id });
        res.send("Auth Successful ✅ Tokens saved to .env. You can now use the APIs.");
    } catch (err) {
        const errorDetails = {
            message: err.message,
            shopee_error: err.response?.data || null,
            status: err.response?.status || null
        };
        console.error("❌ Callback error:", JSON.stringify(errorDetails));
        res.status(500).json(errorDetails);
    }
});

///////////////////////////////////////////////////////////
// 📦 ORDER FILTERING
///////////////////////////////////////////////////////////
app.get("/orders-by-ship-date", async (req, res) => {
    try {
        const targetDateStr = req.query.date || new Date().toISOString().split('T')[0];
        console.log(`🔍 Filtering orders by ship date: ${targetDateStr} (SGT)`);

        // Set time_from to start of target date in SGT (UTC+8)
        const targetDateSGTStart = new Date(`${targetDateStr}T00:00:00+08:00`);
        const timeFrom = Math.floor(targetDateSGTStart.getTime() / 1000);
        const timeTo = Math.floor(Date.now() / 1000);

        // 1. Get List with Pagination
        let allOrders = [];
        let hasNext = true;
        let cursor = "";
        while(hasNext) {
            const listRes = await shopeeRequest("get", "/api/v2/order/get_order_list", {
                page_size: 100, time_range_field: "update_time",
                time_from: timeFrom, time_to: timeTo, cursor: cursor
            });
            const response = listRes.data.response;
            allOrders = allOrders.concat(response.order_list || []);
            hasNext = response.more;
            cursor = response.next_cursor;
            if (allOrders.length > 2000) break; // Safeguard
        }

        const orderSnList = allOrders.map(o => o.order_sn);

        let detailedMatches = [];
        if (orderSnList.length > 0) {
            // 2. Get Details in chunks of 50 (Shopee API limit per request)
            let allDetails = [];
            for (let i = 0; i < orderSnList.length; i += 50) {
                const chunk = orderSnList.slice(i, i + 50);
                const detailRes = await shopeeRequest("get", "/api/v2/order/get_order_detail", {
                    order_sn_list: chunk.join(","),
                    response_optional_fields: "item_list,buyer_username,recipient_address,order_status,pickup_done_time,total_amount"
                });
                allDetails = allDetails.concat(detailRes.data.response.order_list);
            }

            // 3. Filter Details by pickup_done_time (True 'Ship Time' in Excel) using SGT
            detailedMatches = allDetails.filter(order => {
                if (!order.pickup_done_time) return false;
                
                // Add 8 hours to get SGT time
                const d = new Date((order.pickup_done_time + 8 * 3600) * 1000);
                const pad = (n) => n.toString().padStart(2, '0');
                const orderShipDateStr = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
                
                return orderShipDateStr === targetDateStr;
            });

            // Status Filter - strictly enforce SHIPPED by default as requested
            const targetStatus = (req.query.status || "SHIPPED").toUpperCase();
            if (targetStatus !== "ALL") {
                detailedMatches = detailedMatches.filter(order => order.order_status === targetStatus);
            }

            // Format dates and add 'ship_time' explicitly using SGT
            detailedMatches = detailedMatches.map(order => {
                const formatTimeSGT = (ts) => {
                    if (!ts) return null;
                    const d = new Date((ts + 8 * 3600) * 1000);
                    const pad = (n) => n.toString().padStart(2, '0');
                    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
                };

                // Compute product_subtotal per item (deal_price × quantity)
                // and add a order-level product_subtotal summing all items
                const enrichedItems = (order.item_list || []).map(item => ({
                    ...item,
                    product_subtotal: parseFloat(((item.deal_price || 0) * (item.model_quantity_purchased || 1)).toFixed(2))
                }));

                const orderProductSubtotal = parseFloat(
                    enrichedItems.reduce((sum, item) => sum + item.product_subtotal, 0).toFixed(2)
                );

                return {
                    ...order,
                    item_list: enrichedItems,
                    product_subtotal: orderProductSubtotal,
                    ship_time: formatTimeSGT(order.pickup_done_time),
                    estimated_ship_out_date: formatTimeSGT(order.ship_by_date),
                    order_creation_date: formatTimeSGT(order.create_time)
                };
            });
        }

        res.json({ 
            date: targetDateStr, 
            status_filter: req.query.status || "SHIPPED",
            total: detailedMatches.length, 
            orders: detailedMatches 
        });
    } catch (err) {
        res.status(500).json({ error: "Error", details: err.message });
    }
});

app.get("/", (req, res) => res.send("Shopee Integration Fully Automated 🚀"));

// 🔄 Manual refresh endpoint
app.get("/refresh", async (req, res) => {
    const result = await refreshAccessToken();
    if (result) {
        res.json({ success: true, message: "Tokens refreshed!", access_token: result.access_token });
    } else {
        res.status(500).json({ success: false, message: "Refresh failed. You may need to re-authenticate via /auth" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    
    // ⏰ Auto-refresh tokens every 3 hours to keep them alive
    setInterval(async () => {
        console.log("⏰ Scheduled token refresh...");
        const result = await refreshAccessToken();
        if (result) {
            console.log("✅ Scheduled refresh successful!");
        } else {
            console.log("❌ Scheduled refresh failed - tokens may have expired.");
        }
    }, 3 * 60 * 60 * 1000); // Every 3 hours
});