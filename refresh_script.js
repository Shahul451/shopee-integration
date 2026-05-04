require("dotenv").config();
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const PARTNER_ID = Number(process.env.PARTNER_ID);
const PARTNER_KEY = process.env.PARTNER_KEY;
const BASE_URL = process.env.BASE_URL;

function generateSign(baseString) {
    return crypto.createHmac("sha256", PARTNER_KEY).update(baseString).digest("hex");
}

async function refresh() {
    const p = "/api/v2/auth/access_token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateSign(`${PARTNER_ID}${p}${timestamp}`);

    try {
        const res = await axios.post(`${BASE_URL}${p}`, 
            { refresh_token: process.env.REFRESH_TOKEN, shop_id: Number(process.env.SHOP_ID), partner_id: PARTNER_ID },
            { params: { partner_id: PARTNER_ID, timestamp, sign }, headers: {'Content-Type': 'application/json'} }
        );
        console.log("Response:", res.data);
        if (res.data.access_token) {
            const envPath = path.join(__dirname, ".env");
            let envContent = fs.readFileSync(envPath, "utf8");
            envContent = envContent.replace(/ACCESS_TOKEN=.*/, `ACCESS_TOKEN=${res.data.access_token}`);
            envContent = envContent.replace(/REFRESH_TOKEN=.*/, `REFRESH_TOKEN=${res.data.refresh_token}`);
            fs.writeFileSync(envPath, envContent);
            console.log("Tokens successfully saved to .env");
        }
    } catch(err) {
        console.error("Error:", err.response?.data || err.message);
    }
}
refresh();
