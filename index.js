require('dotenv').config();
const express = require("express");
const session = require('express-session');
const { Pool } = require("pg");
const bcrypt = require('bcrypt');

// ============ GUARD: Fail fast on missing critical env vars ============
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set. Exiting.');
    process.exit(1);
}
if (!process.env.SESSION_SECRET) {
    console.error('❌ SESSION_SECRET is not set. Exiting.');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 1000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// EJS Setup
app.set("view engine", "ejs");

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// ============ DATABASE CONFIGURATION ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 60000,
    max: 10,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
});

pool.on('error', (err) => {
    console.error('Unexpected database error:', err.message);
});

// ============ DATABASE CONNECTION TEST ============
const testConnection = async () => {
    let retries = 5;
    while (retries > 0) {
        try {
            const client = await pool.connect();
            console.log('✅ Database connected successfully');
            client.release();
            return;
        } catch (err) {
            retries--;
            console.error(`❌ Connection attempt failed (${retries} retries left):`, err.message);
            if (retries > 0) {
                console.log('⏳ Waiting 2 seconds before retry...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    console.error('❌ Failed to connect to database after multiple attempts');
    process.exit(1);
};

testConnection();

// ============ KEEP-ALIVE (production: every 5 min; dev: every 30s) ============
const KEEPALIVE_INTERVAL = process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 30000;
setInterval(async () => {
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
    } catch (err) {
        console.error('⚠️ Keep-alive query failed:', err.message);
    }
}, KEEPALIVE_INTERVAL);

// ============ DATABASE QUERY HELPER ============
// FIXED: All queries use $N placeholders natively — no ? substitution needed.
// This avoids double-substitution bugs when queries already contain $N.
const exe = async (sql, params = []) => {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query(sql, params);
        return result.rows;
    } catch (err) {
        console.error("Database error:", err.message);
        console.error("SQL:", sql);
        console.error("Params:", params);
        throw new Error(`Database operation failed: ${err.message}`);
    } finally {
        if (client) client.release();
    }
};

// ============ AUTHENTICATION MIDDLEWARE ============
function check_user_login(req, res, next) {
    if (req.session && req.session.oname) {
        return next();
    }
    req.session.returnTo = req.originalUrl;
    res.redirect("/deptlogindashboard");
}

// ============ INPUT SANITIZATION HELPER ============
function sanitize(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
}

// ---------- Routes ----------

app.get("/", (req, res) => {
    res.render("home");
});

app.get("/deptlogindashboard", (req, res) => {
    res.render("deptlogindashboard.ejs");
});

// ============ LOGIN ============
app.post("/checkauthuser", async (req, res) => {
    try {
        const username = sanitize(req.body.username);
        const password = sanitize(req.body.password);

        if (!username || !password) {
            return res.send(`<script>alert('Please enter username and password'); window.location.href='/deptlogindashboard';</script>`);
        }

        // Single clean query — no manual retry (pool handles reconnect)
        const result = await exe("SELECT * FROM operator WHERE username = $1", [username]);

        if (result.length === 0) {
            return res.send(`<script>alert('Invalid Username or Password'); window.location.href='/deptlogindashboard';</script>`);
        }

        const user = result[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.send(`<script>alert('Invalid Username or Password'); window.location.href='/deptlogindashboard';</script>`);
        }

        req.session.oname = {
            oid: user.oid,
            oname: user.oname,
            deptname: user.deptname,
            role: user.role,
            username: user.username
        };
        req.session.userId = user.oid;

        const redirectMap = {
            "Laser Department_user": "/laserproductionreport",
            "Laser Department_admin": "/adminlasetdashboard",
            "Punching Department_user": "/punchingreport",
            "Punching Department_admin": "/admin_punching_dashboard"
        };

        const redirectPath = redirectMap[`${user.deptname}_${user.role}`] || "/deptlogindashboard";
        return res.redirect(redirectPath);

    } catch (err) {
        console.error("Login Error:", err);
        const errorMessage = err.message.includes('timeout')
            ? 'Database connection timeout. Please try again.'
            : 'Server Error. Please try again.';
        return res.send(`<script>alert('${errorMessage}'); window.location.href='/deptlogindashboard';</script>`);
    }
});

// ============ LOGOUT ============
app.get("/logoutuser", check_user_login, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.send(`<script>alert('Error during logout'); window.location.href='/deptlogindashboard';</script>`);
        }
        res.redirect("/deptlogindashboard");
    });
});

// ---------- LASER DEPARTMENT ROUTES ----------

app.get("/adminlasetdashboard", check_user_login, async (req, res) => {
    try {
        const d = req.session.oname.oname;
        const [records, customer, material, project] = await Promise.all([
            exe("SELECT * FROM laserdept ORDER BY g_id DESC"),
            exe("SELECT * FROM customers"),
            exe("SELECT * FROM material"),
            exe("SELECT * FROM project")
        ]);
        res.render("adminlasetdashboard.ejs", { records, d, customer, material, project });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading dashboard");
    }
});

app.get("/laserproductionreport", check_user_login, async (req, res) => {
    try {
        const onamee = req.session.oname.oname;
        const [customer, operator, material, project] = await Promise.all([
            exe("SELECT * FROM customers"),
            exe("SELECT * FROM operator WHERE deptname = $1 AND oname = $2", ["Laser Department", onamee]),
            exe("SELECT * FROM material"),
            exe("SELECT * FROM project")
        ]);
        res.render("laserproductionreport.ejs", { customer, operator, material, project });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading page");
    }
});

app.get("/get_projects/:customer", check_user_login, async (req, res) => {
    try {
        const customer = sanitize(req.params.customer);
        const projects = await exe("SELECT * FROM project WHERE cuname = $1", [customer]);
        res.json(projects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});

app.post("/save_details", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        const sql = `
            INSERT INTO laserdept (
                g_date, g_operator_name, g_shift, g_customer, g_project_name,
                g_set_name, g_material, g_sheetqty, g_length, g_width, g_thickness,
                g_totalweight, g_start_time, g_end_time, g_time, g_m_processtime,
                g_mureason, other_gmr, g_mjustification, g_rejectionqty
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `;
        await exe(sql, [
            sanitize(d.g_date), sanitize(d.g_operator_name), sanitize(d.g_shift),
            sanitize(d.g_customer), sanitize(d.g_project_name), sanitize(d.g_set_name),
            sanitize(d.g_material), sanitize(d.g_sheetqty), sanitize(d.g_length),
            sanitize(d.g_width), sanitize(d.g_thickness), sanitize(d.g_totalweight),
            sanitize(d.g_start_time), sanitize(d.g_end_time),
            sanitize(d.g_process_time) || sanitize(d.g_time),
            sanitize(d.g_m_processtime), sanitize(d.g_mureason), sanitize(d.other_gmr),
            sanitize(d.g_mjustification), sanitize(d.g_rejectionqty)
        ]);
        const redirectUrl = req.session.oname.role === "admin" ? "/adminlasetdashboard" : "/laserproductionreport";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.get("/laserproductionrecord", check_user_login, async (req, res) => {
    try {
        const onamee = req.session.oname.oname;
        const records = await exe("SELECT * FROM laserdept WHERE g_operator_name = $1 ORDER BY g_id DESC", [onamee]);
        res.render("laserproductionrecord.ejs", { records });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading records");
    }
});

app.get("/laserproductionedit/:id", check_user_login, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).send("Invalid ID");
        const orole = req.session.oname.role;
        const [data, customer] = await Promise.all([
            exe("SELECT * FROM laserdept WHERE g_id = $1", [id]),
            exe("SELECT * FROM customers")
        ]);
        if (!data || data.length === 0) return res.status(404).send("Record not found");
        res.render("laserproductionedit.ejs", { data: data[0], customer, orole });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading edit page");
    }
});

app.post("/update_details", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        const id = parseInt(d.g_id, 10);
        if (isNaN(id)) return res.send(`<script>alert('Invalid record ID'); window.history.back();</script>`);
        await exe(`
            UPDATE laserdept SET
                g_operator_name=$1, g_shift=$2, g_customer=$3, g_project_name=$4,
                g_set_name=$5, g_material=$6, g_sheetqty=$7, g_length=$8, g_width=$9,
                g_thickness=$10, g_totalweight=$11, g_start_time=$12, g_end_time=$13,
                g_time=$14, g_m_processtime=$15, g_mureason=$16, other_gmr=$17,
                g_mjustification=$18, g_rejectionqty=$19
            WHERE g_id=$20
        `, [
            sanitize(d.g_operator_name), sanitize(d.g_shift), sanitize(d.g_customer),
            sanitize(d.g_project_name), sanitize(d.g_set_name), sanitize(d.g_material),
            sanitize(d.g_sheetqty), sanitize(d.g_length), sanitize(d.g_width),
            sanitize(d.g_thickness), sanitize(d.g_totalweight), sanitize(d.g_start_time),
            sanitize(d.g_end_time), sanitize(d.g_process_time) || sanitize(d.g_time),
            sanitize(d.g_m_processtime), sanitize(d.g_mureason), sanitize(d.other_gmr),
            sanitize(d.g_mjustification), sanitize(d.g_rejectionqty), id
        ]);
        const redirectUrl = req.session.oname.role === "admin" ? "/adminlasetdashboard" : "/laserproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Updating Record'); window.history.back();</script>`);
    }
});

// FIXED: Changed from GET to POST to prevent CSRF via <img> tags
app.post("/delete/:id", check_user_login, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.send(`<script>alert('Invalid ID'); window.history.back();</script>`);
        await exe("DELETE FROM laserdept WHERE g_id=$1", [id]);
        const redirectUrl = req.session.oname.role === "admin" ? "/adminlasetdashboard" : "/laserproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Deleting Record'); window.history.back();</script>`);
    }
});

// ---------- MASTER DATA ROUTES ----------

app.post("/save_operator", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        if (!d.password || d.password.length < 6) {
            return res.send(`<script>alert('Password must be at least 6 characters'); window.history.back();</script>`);
        }
        const hashedPassword = await bcrypt.hash(d.password, 10);
        await exe(
            "INSERT INTO operator (deptname, oname, username, password, role) VALUES ($1,$2,$3,$4,$5)",
            [sanitize(d.deptname), sanitize(d.oname), sanitize(d.username), hashedPassword, sanitize(d.role)]
        );
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard" : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_customer", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        await exe("INSERT INTO customers (cname) VALUES ($1)", [sanitize(d.cname)]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard" : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_project", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        await exe("INSERT INTO project (cuname, pname) VALUES ($1,$2)", [sanitize(d.cuname), sanitize(d.pname)]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard" : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_material", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        await exe("INSERT INTO material (mname) VALUES ($1)", [sanitize(d.mname)]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard" : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

// ---------- PUNCHING DEPARTMENT ROUTES ----------

app.get("/punchingreport", check_user_login, async (req, res) => {
    try {
        const onamee = req.session.oname.oname;
        const [customer, operator, material, project] = await Promise.all([
            exe("SELECT * FROM customers"),
            exe("SELECT * FROM operator WHERE deptname = $1 AND oname = $2", ["Punching Department", onamee]),
            exe("SELECT * FROM material"),
            exe("SELECT * FROM project")
        ]);
        res.render("punchingreport.ejs", { customer, operator, material, project });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading page");
    }
});

app.post("/save_punchiing_details", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        const sql = `
            INSERT INTO punchingdept (
                p_date, p_operator_name, p_shift, p_machine, p_customer,
                p_project_name, p_set_name, p_material, p_sheetqty, p_length,
                p_width, p_thickness, p_totalweight, p_start_time, p_end_time,
                p_time, p_m_processtime, p_mureason, other_gmr, p_mjustification, p_rejectionqty
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        `;
        await exe(sql, [
            sanitize(d.p_date), sanitize(d.p_operator_name), sanitize(d.p_shift),
            sanitize(d.p_machine), sanitize(d.p_customer), sanitize(d.p_project_name),
            sanitize(d.p_set_name), sanitize(d.p_material), sanitize(d.p_sheetqty),
            sanitize(d.p_length), sanitize(d.p_width), sanitize(d.p_thickness),
            sanitize(d.p_totalweight), sanitize(d.p_start_time), sanitize(d.p_end_time),
            sanitize(d.p_process_time) || sanitize(d.p_time),
            sanitize(d.p_m_processtime), sanitize(d.p_mureason), sanitize(d.other_gmr),
            sanitize(d.p_mjustification), sanitize(d.p_rejectionqty)
        ]);
        const redirectUrl = req.session.oname.role === "admin" ? "/admin_punching_dashboard" : "/punchingreport";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.get("/punchingproductionrecord", check_user_login, async (req, res) => {
    try {
        const onamee = req.session.oname.oname;
        const records = await exe("SELECT * FROM punchingdept WHERE p_operator_name = $1 ORDER BY p_id DESC", [onamee]);
        res.render("punchingproductionrecord.ejs", { records });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading records");
    }
});

app.get("/punchingproductionedit/:id", check_user_login, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).send("Invalid ID");
        const orole = req.session.oname.role;
        const [data, customer] = await Promise.all([
            exe("SELECT * FROM punchingdept WHERE p_id = $1", [id]),
            exe("SELECT * FROM customers")
        ]);
        if (!data || data.length === 0) return res.status(404).send("Record not found");
        res.render("punchingproductionedit.ejs", { data: data[0], customer, orole });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading edit page");
    }
});

app.post("/update_punchinp_details", check_user_login, async (req, res) => {
    try {
        const d = req.body;
        const id = parseInt(d.p_id, 10);
        if (isNaN(id)) return res.send(`<script>alert('Invalid record ID'); window.history.back();</script>`);
        await exe(`
            UPDATE punchingdept SET
                p_operator_name=$1, p_shift=$2, p_machine=$3, p_customer=$4,
                p_project_name=$5, p_set_name=$6, p_material=$7, p_sheetqty=$8,
                p_length=$9, p_width=$10, p_thickness=$11, p_totalweight=$12,
                p_start_time=$13, p_end_time=$14, p_time=$15, p_m_processtime=$16,
                p_mureason=$17, other_gmr=$18, p_mjustification=$19, p_rejectionqty=$20
            WHERE p_id=$21
        `, [
            sanitize(d.p_operator_name), sanitize(d.p_shift), sanitize(d.p_machine),
            sanitize(d.p_customer), sanitize(d.p_project_name), sanitize(d.p_set_name),
            sanitize(d.p_material), sanitize(d.p_sheetqty), sanitize(d.p_length),
            sanitize(d.p_width), sanitize(d.p_thickness), sanitize(d.p_totalweight),
            sanitize(d.p_start_time), sanitize(d.p_end_time),
            sanitize(d.p_process_time) || sanitize(d.p_time),
            sanitize(d.p_m_processtime), sanitize(d.p_mureason), sanitize(d.other_gmr),
            sanitize(d.p_mjustification), sanitize(d.p_rejectionqty), id
        ]);
        const redirectUrl = req.session.oname.role === "admin" ? "/admin_punching_dashboard" : "/punchingproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Updating Record'); window.history.back();</script>`);
    }
});

// FIXED: Changed from GET to POST to prevent CSRF
app.post("/punchingdelete/:id", check_user_login, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.send(`<script>alert('Invalid ID'); window.history.back();</script>`);
        await exe("DELETE FROM punchingdept WHERE p_id=$1", [id]);
        const redirectUrl = req.session.oname.role === "admin" ? "/admin_punching_dashboard" : "/punchingproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Deleting Record'); window.history.back();</script>`);
    }
});

app.get("/admin_punching_dashboard", check_user_login, async (req, res) => {
    try {
        const d = req.session.oname.oname;
        const [records, customer, material, project] = await Promise.all([
            exe("SELECT * FROM punchingdept ORDER BY p_id DESC"),
            exe("SELECT * FROM customers"),
            exe("SELECT * FROM material"),
            exe("SELECT * FROM project")
        ]);
        res.render("admin_punching_dashboard.ejs", { records, d, customer, material, project });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading dashboard");
    }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
let isShuttingDown = false;
const shutdown = async (signal) => {
    if (isShuttingDown) {
        console.log(`⚠️  Shutdown already in progress, ignoring duplicate ${signal}`);
        return;
    }
    isShuttingDown = true;
    console.log(`\n👋 Received ${signal}. Shutting down gracefully...`);
    console.trace('Shutdown triggered from:');
    try {
        await pool.end();
        console.log('✅ Database pool closed');
    } catch (err) {
        console.error('Error closing pool:', err.message);
    }
    process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Catch unhandled errors so we can see what's actually happening
process.on("unhandledRejection", (reason) => {
    console.error('🔴 Unhandled Rejection:', reason);
});
process.on("uncaughtException", (err) => {
    console.error('🔴 Uncaught Exception:', err);
});