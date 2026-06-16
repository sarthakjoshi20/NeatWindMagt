require('dotenv').config();
const express = require("express");
const session = require('express-session');
const { Pool } = require("pg");
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 1000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// EJS Setup
app.set("view engine", "ejs");

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
        process.exit(1);
    } else {
        console.log('Database connected successfully');
        release();
    }
});

// Helper function
const exe = async (sql, params = []) => {
    let paramCounter = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramCounter}`);
    try {
        const result = await pool.query(pgSql, params);
        return result.rows;
    } catch (err) {
        console.error("Database error:", err.message);
        console.error("SQL Query:", pgSql);
        console.error("Parameters:", params);
        throw new Error(`Database operation failed: ${err.message}`);
    }
};

// Transaction helper
const transaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

// Authentication middleware
function check_user_login(req, res, next) {
    if (req.session && req.session.oname) {
        return next();
    }
    req.session.returnTo = req.originalUrl;
    res.redirect("/deptlogindashboard");
}

// ---------- Routes ----------
app.get("/", (req, res) => {
    res.render("home");
});

app.get("/deptlogindashboard", (req, res) => {
    res.render("deptlogindashboard.ejs");
});

// ---------- USER LOGIN ----------
app.post("/checkauthuser", async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log("User login attempt:", username);

        const sql = `SELECT * FROM operator WHERE username = $1`;
        const result = await exe(sql, [username]);

        if (result.length > 0) {
            const user = result[0];
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                console.log("User login successful:", username);
                req.session.oname = user;

                // Redirect based on department and role
                const { deptname, role } = user;
                if (deptname === "Laser Department" && role === "user")
                    return res.redirect("/laserproductionreport");
                if (deptname === "Laser Department" && role === "admin")
                    return res.redirect("/adminlasetdashboard");
                if (deptname === "Punching Department" && role === "user")
                    return res.redirect("/punchingreport");
                if (deptname === "Punching Department" && role === "admin")
                    return res.redirect("/admin_punching_dashboard");

                return res.redirect("/deptlogindashboard");
            }
        }
        
        console.log("User login failed:", username);
        res.send(`
            <script>
                alert('Invalid Staff Credentials');
                window.location.href = '/deptlogindashboard';
            </script>
        `);
    } catch (err) {
        console.error("User login error:", err);
        res.send(`
            <script>
                alert('Error during staff login');
                window.location.href = '/deptlogindashboard';
            </script>
        `);
    }
});

// Logout
app.get("/logoutuser", check_user_login, async (req, res) => {
    const returnTo = req.session.returnTo || '/deptlogindashboard';
    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.status(500).send("Logout failed");
        }
        res.redirect(returnTo);
    });
});

// ---------- LASER DEPARTMENT ROUTES ----------
app.get("/adminlasetdashboard", check_user_login, async (req, res) => {
    try {
        let d = req.session.oname.oname;
        let [records, customer, material, project] = await Promise.all([
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
        let onamee = req.session.oname.oname;
        let [customer, operator, material, project] = await Promise.all([
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
        let customer = req.params.customer;
        let projects = await exe("SELECT * FROM project WHERE cuname = $1", [customer]);
        res.json(projects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});

app.post("/save_details", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        console.log("Form Data:", d);

        let sql = `
            INSERT INTO laserdept (
                g_date, g_operator_name, g_shift, g_customer, g_project_name,
                g_set_name, g_material, g_sheetqty, g_length, g_width, g_thickness,
                g_totalweight, g_start_time, g_end_time, g_time, g_m_processtime,
                g_mureason, other_gmr, g_mjustification, g_rejectionqty
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        `;
        await exe(sql, [
            d.g_date, d.g_operator_name, d.g_shift, d.g_customer, d.g_project_name,
            d.g_set_name, d.g_material, d.g_sheetqty, d.g_length, d.g_width, d.g_thickness,
            d.g_totalweight, d.g_start_time, d.g_end_time, d.g_process_time, d.g_m_processtime,
            d.g_mureason, d.other_gmr, d.g_mjustification, d.g_rejectionqty
        ]);

        const redirectUrl = req.session.oname.role === "admin" 
            ? "/adminlasetdashboard" 
            : "/laserproductionreport";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record: ${err.message}'); window.history.back();</script>`);
    }
});

app.get("/laserproductionrecord", check_user_login, async (req, res) => {
    try {
        let onamee = req.session.oname.oname;
        let records = await exe("SELECT * FROM laserdept WHERE g_operator_name = $1 ORDER BY g_id DESC", [onamee]);
        res.render("laserproductionrecord.ejs", { records });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading records");
    }
});

app.get("/laserproductionedit/:id", check_user_login, async (req, res) => {
    try {
        let id = req.params.id;
        let orole = req.session.oname.role;
        let [data, customer] = await Promise.all([
            exe("SELECT * FROM laserdept WHERE g_id = $1", [id]),
            exe("SELECT * FROM customers")
        ]);
        if (!data || data.length === 0) {
            return res.status(404).send("Record not found");
        }
        res.render("laserproductionedit.ejs", { data: data[0], customer, orole });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading edit page");
    }
});

app.post("/update_details", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        await exe(`
            UPDATE laserdept SET
                g_operator_name=$1, g_shift=$2, g_customer=$3, g_project_name=$4,
                g_set_name=$5, g_material=$6, g_sheetqty=$7, g_length=$8, g_width=$9,
                g_thickness=$10, g_totalweight=$11, g_start_time=$12, g_end_time=$13,
                g_time=$14, g_m_processtime=$15, g_mureason=$16, other_gmr=$17,
                g_mjustification=$18, g_rejectionqty=$19
            WHERE g_id=$20
        `, [
            d.g_operator_name, d.g_shift, d.g_customer, d.g_project_name, d.g_set_name,
            d.g_material, d.g_sheetqty, d.g_length, d.g_width, d.g_thickness, d.g_totalweight,
            d.g_start_time, d.g_end_time, d.g_process_time, d.g_m_processtime, d.g_mureason,
            d.other_gmr, d.g_mjustification, d.g_rejectionqty, d.g_id
        ]);
        
        const redirectUrl = req.session.oname.role === "admin" 
            ? "/adminlasetdashboard" 
            : "/laserproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Updating Record: ${err.message}'); window.history.back();</script>`);
    }
});

app.get("/delete/:id", check_user_login, async (req, res) => {
    try {
        let id = req.params.id;
        await exe("DELETE FROM laserdept WHERE g_id=$1", [id]);
        const redirectUrl = req.session.oname.role === "admin" 
            ? "/adminlasetdashboard" 
            : "/laserproductionrecord";
        res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Deleting Record: ${err.message}'); window.history.back();</script>`);
    }
});

// ---------- MASTER DATA ROUTES ----------
app.post("/save_operator", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        const hashedPassword = await bcrypt.hash(d.password, 10);
        await exe("INSERT INTO operator (deptname, oname, username, password, role) VALUES ($1, $2, $3, $4, $5)", 
            [d.deptname, d.oname, d.username, hashedPassword, d.role]);

        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard"
            : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record: ${err.message}'); window.history.back();</script>`);
    }
});

// Similar updates for save_customer, save_project, save_material...

// ---------- PUNCHING DEPARTMENT ROUTES ----------
// (Similar updates as laser department routes)

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`Server Running on http://localhost:${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    console.log('Database pool closed');
    process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);