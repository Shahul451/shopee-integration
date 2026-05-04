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

// 📝 Helper to update .env file automatically
function updateEnv(newTokens) {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.readFileSync(envPath, "utf8");

    if (newTokens.access_token) {
        if (envContent.match(/ACCESS_TOKEN=.*/)) {
            envContent = envContent.replace(/ACCESS_TOKEN=.*/, `ACCESS_TOKEN=${newTokens.access_token}`);
        } else {
            envContent += `\nACCESS_TOKEN=${newTokens.access_token}`;
        }
        process.env.ACCESS_TOKEN = newTokens.access_token;
    }
    if (newTokens.refresh_token) {
        if (envContent.match(/REFRESH_TOKEN=.*/)) {
            envContent = envContent.replace(/REFRESH_TOKEN=.*/, `REFRESH_TOKEN=${newTokens.refresh_token}`);
        } else {
            envContent += `\nREFRESH_TOKEN=${newTokens.refresh_token}`;
        }
        process.env.REFRESH_TOKEN = newTokens.refresh_token;
    }
    if (newTokens.shop_id) {
        if (envContent.match(/SHOP_ID=.*/)) {
            envContent = envContent.replace(/SHOP_ID=.*/, `SHOP_ID=${newTokens.shop_id}`);
        } else {
            envContent += `\nSHOP_ID=${newTokens.shop_id}`;
        }
        process.env.SHOP_ID = newTokens.shop_id;
    }

    fs.writeFileSync(envPath, envContent);
    console.log("✅ .env file updated automatically.");
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
        const path = "/api/v2/auth/token/get";
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(`${PARTNER_ID}${path}${timestamp}`);

        const response = await axios.post(`${BASE_URL}${path}`, 
            { code, shop_id: Number(shop_id), partner_id: PARTNER_ID },
            { params: { partner_id: PARTNER_ID, timestamp, sign } }
        );

        updateEnv({ access_token: response.data.access_token, refresh_token: response.data.refresh_token, shop_id: shop_id });
        res.send("Auth Successful ✅ Tokens saved to .env. You can now use the APIs.");
    } catch (err) {
        res.status(500).send(err.response?.data || "Token error");
    }
});

///////////////////////////////////////////////////////////
// 📦 ORDER FILTERING
///////////////////////////////////////////////////////////
app.get("/orders-by-arranged-date", async (req, res) => {
    try {
        const targetDateStr = req.query.date || new Date().toISOString().split('T')[0];
        console.log(`🔍 Filtering orders ARRANGED on: ${targetDateStr}`);

        // 1. Get List
        const listRes = await shopeeRequest("get", "/api/v2/order/get_order_list", {
            page_size: 50, time_range_field: "create_time",
            time_from: Math.floor(Date.now() / 1000) - (15 * 86400),
            time_to: Math.floor(Date.now() / 1000)
        });

        const orderSnList = listRes.data.response.order_list.map(o => o.order_sn);
        const matchingSns = [];

        // 2. Check Tracking (Iterative)
        for (const order_sn of orderSnList) {
            try {
                const trackRes = await shopeeRequest("get", "/api/v2/logistics/get_tracking_info", { order_sn });
                const history = trackRes.data.response.tracking_info;
                const arrangeEvent = history.find(h => h.description.includes("Sender is preparing to ship"));
                if (arrangeEvent) {
                    if (new Date(arrangeEvent.update_time * 1000).toISOString().split('T')[0] === targetDateStr) {
                        matchingSns.push(order_sn);
                    }
                }
            } catch (e) { continue; }
        }

        // 3. Get Details
        let detailedMatches = [];
        if (matchingSns.length > 0) {
            const detailRes = await shopeeRequest("get", "/api/v2/order/get_order_detail", {
                order_sn_list: matchingSns.join(","),
                response_optional_fields: "item_list,buyer_username,recipient_address,order_status"
            });
            detailedMatches = detailRes.data.response.order_list;

            // Optional Status Filter
            if (req.query.status) {
                const targetStatus = req.query.status.toUpperCase();
                detailedMatches = detailedMatches.filter(order => order.order_status === targetStatus);
            }
        }

        res.json({ 
            date: targetDateStr, 
            status_filter: req.query.status || "ALL",
            total: detailedMatches.length, 
            orders: detailedMatches 
        });
    } catch (err) {
        res.status(500).json({ error: "Error", details: err.message });
    }
});

app.get("/", (req, res) => res.send("Shopee Integration Fully Automated 🚀"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));