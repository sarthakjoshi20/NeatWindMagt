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

// Session configuration (secure)
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,          // Changed from true to avoid unnecessary writes
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// PostgreSQL connection pool (SSL properly enabled)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

// Helper function to convert MySQL ? placeholders to PostgreSQL $1, $2, ...
const exe = async (sql, params = []) => {
    let paramCounter = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramCounter}`);
    try {
        const result = await pool.query(pgSql, params);
        return result.rows;
    } catch (err) {
        console.error("Database error:", err.message);
        throw new Error("Database operation failed");
    }
};

// ---------- Routes ----------

app.get("/", (req, res) => {
    res.render("home");
});

app.get("/deptlogindashboard", (req, res) => {
    res.render("deptlogindashboard.ejs");
});

// ---------- USER LOGIN (with bcrypt) ----------
app.post("/checkauthuser", async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Input validation
        if (!username || !password) {
            console.log("Login attempt with missing credentials");
            return res.status(400).send(`
                <script>
                    alert('Please enter both username and password');
                    window.location.href = '/deptlogindashboard';
                </script>
            `);
        }

        console.log("User login attempt:", username);

        // Fetch user by username
        const sql = `SELECT * FROM operator WHERE username = $1`;
        const result = await exe(sql, [username]);

        if (result.length > 0) {
            const user = result[0];
            
            // Compare provided password with stored hash
            const match = await bcrypt.compare(password, user.password);
            
            if (match) {
                console.log("User login successful:", username);
                
                // Store user info in session (excluding sensitive data)
                req.session.oname = {
                    oid: user.oid,
                    oname: user.oname,
                    deptname: user.deptname,
                    role: user.role,
                    username: user.username
                };
                req.session.userId = user.oid;
                req.session.loginTime = new Date().toISOString();

                // Redirect based on department and role
                const { deptname, role } = user;
                
                // Use a switch statement for cleaner code
                const redirectMap = {
                    'Laser Department_user': '/laserproductionreport',
                    'Laser Department_admin': '/adminlasetdashboard',
                    'Punching Department_user': '/punchingreport',
                    'Punching Department_admin': '/admin_punching_dashboard'
                };
                
                const redirectPath = redirectMap[`${deptname}_${role}`];
                if (redirectPath) {
                    return res.redirect(redirectPath);
                }
                
                // Fallback for unknown department/role combinations
                console.warn(`Unknown department/role combination: ${deptname}/${role}`);
                return res.redirect("/deptlogindashboard");
            }
        }
        
        // Invalid credentials - use a generic message for security
        console.log("User login failed:", username);
        return res.status(401).send(`
            <script>
                alert('Invalid username or password');
                window.location.href = '/deptlogindashboard';
            </script>
        `);
        
    } catch (err) {
        console.error("User login error:", err);
        return res.status(500).send(`
            <script>
                alert('An error occurred during login. Please try again.');
                window.location.href = '/deptlogindashboard';
            </script>
        `);
    }
});

// Logout
app.get("/logoutuser", check_user_login, async (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error("Error destroying session:", err);
            return res.status(500).send("Logout failed");
        }
        res.redirect("/deptlogindashboard");
    });
});

function check_user_login(req, res, next) {
    if (req.session.oname) return next();
    res.redirect("/deptlogindashboard");
}

// ---------- LASER DEPARTMENT ROUTES ----------
app.get("/adminlasetdashboard", check_user_login, async (req, res) => {
    let d = req.session.oname.oname;
    let records = await exe("SELECT * FROM laserdept ORDER BY g_id DESC");
    let customer = await exe("SELECT * FROM customers");
    let material = await exe("SELECT * FROM material");
    let project = await exe("SELECT * FROM project");
    res.render("adminlasetdashboard.ejs", { records, d, customer, material, project });
});

app.get("/laserproductionreport", check_user_login, async (req, res) => {
    let onamee = req.session.oname.oname;
    let customer = await exe("SELECT * FROM customers");
    let operator = await exe("SELECT * FROM operator WHERE deptname = $1 AND oname = $2", ["Laser Department", onamee]);
    let material = await exe("SELECT * FROM material");
    let project = await exe("SELECT * FROM project");
    res.render("laserproductionreport.ejs", { customer, operator, material, project });
});

app.get("/get_projects/:customer", async (req, res) => {
    let customer = req.params.customer;
    let projects = await exe("SELECT * FROM project WHERE cuname = $1", [customer]);
    res.json(projects);
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

        if (req.session.oname.role === "admin") res.redirect("/adminlasetdashboard");
        else res.redirect("/laserproductionreport");
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.get("/laserproductionrecord", check_user_login, async (req, res) => {
    let onamee = req.session.oname.oname;
    let records = await exe("SELECT * FROM laserdept WHERE g_operator_name = $1 ORDER BY g_id DESC", [onamee]);
    res.render("laserproductionrecord.ejs", { records });
});

app.get("/laserproductionedit/:id", check_user_login, async (req, res) => {
    let id = req.params.id;
    let orole = req.session.oname.role;
    let data = await exe("SELECT * FROM laserdept WHERE g_id = $1", [id]);
    let customer = await exe("SELECT * FROM customers");
    res.render("laserproductionedit.ejs", { data: data[0], customer, orole });
});

app.post("/update_details", check_user_login, async (req, res) => {
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
    if (req.session.oname.role === "admin") res.redirect("/adminlasetdashboard");
    else res.redirect("/laserproductionrecord");
});

app.get("/delete/:id", check_user_login, async (req, res) => {
    let id = req.params.id;
    await exe("DELETE FROM laserdept WHERE g_id=$1", [id]);
    if (req.session.oname.role === "admin") res.redirect("/adminlasetdashboard");
    else res.redirect("/laserproductionrecord");
});

// ---------- MASTER DATA ROUTES (with bcrypt for operator password) ----------
app.post("/save_operator", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        // Hash the password before storing
        const hashedPassword = await bcrypt.hash(d.password, 10);
        let sql = `INSERT INTO operator (deptname, oname, username, password, role) VALUES ($1, $2, $3, $4, $5)`;
        await exe(sql, [d.deptname, d.oname, d.username, hashedPassword, d.role]);

        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard"
            : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_customer", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        await exe("INSERT INTO customers (cname) VALUES ($1)", [d.cname]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard"
            : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_project", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        await exe("INSERT INTO project (cuname, pname) VALUES ($1, $2)", [d.cuname, d.pname]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard"
            : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.post("/save_material", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        await exe("INSERT INTO material (mname) VALUES ($1)", [d.mname]);
        const redirectUrl = (req.session.oname.deptname === "Laser Department" && req.session.oname.role === "admin")
            ? "/adminlasetdashboard"
            : "/admin_punching_dashboard";
        res.send(`<script>alert('Record Saved Successfully'); window.location='${redirectUrl}';</script>`);
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

// ---------- PUNCHING DEPARTMENT ROUTES ----------
app.get("/punchingreport", check_user_login, async (req, res) => {
    let onamee = req.session.oname.oname;
    let customer = await exe("SELECT * FROM customers");
    let operator = await exe("SELECT * FROM operator WHERE deptname = $1 AND oname = $2", ["Punching Department", onamee]);
    let material = await exe("SELECT * FROM material");
    let project = await exe("SELECT * FROM project");
    res.render("punchingreport.ejs", { customer, operator, material, project });
});

app.post("/save_punchiing_details", check_user_login, async (req, res) => {
    try {
        let d = req.body;
        let sql = `
            INSERT INTO punchingdept (
                p_date, p_operator_name, p_shift, p_machine, p_customer,
                p_project_name, p_set_name, p_material, p_sheetqty, p_length,
                p_width, p_thickness, p_totalweight, p_start_time, p_end_time,
                p_time, p_m_processtime, p_mureason, other_gmr, p_mjustification, p_rejectionqty
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        `;
        await exe(sql, [
            d.p_date, d.p_operator_name, d.p_shift, d.p_machine, d.p_customer,
            d.p_project_name, d.p_set_name, d.p_material, d.p_sheetqty, d.p_length,
            d.p_width, d.p_thickness, d.p_totalweight, d.p_start_time, d.p_end_time,
            d.p_process_time, d.p_m_processtime, d.p_mureason, d.other_gmr, d.p_mjustification, d.p_rejectionqty
        ]);
        if (req.session.oname.role === "admin") res.redirect("/admin_punching_dashboard");
        else res.redirect("/punchingreport");
    } catch (err) {
        console.error(err);
        res.send(`<script>alert('Error Saving Record'); window.history.back();</script>`);
    }
});

app.get("/punchingproductionrecord", check_user_login, async (req, res) => {
    let onamee = req.session.oname.oname;
    let records = await exe("SELECT * FROM punchingdept WHERE p_operator_name = $1 ORDER BY p_id DESC", [onamee]);
    res.render("punchingproductionrecord.ejs", { records });
});

app.get("/punchingproductionedit/:id", check_user_login, async (req, res) => {
    let id = req.params.id;
    let orole = req.session.oname.role;
    let data = await exe("SELECT * FROM punchingdept WHERE p_id = $1", [id]);
    let customer = await exe("SELECT * FROM customers");
    res.render("punchingproductionedit.ejs", { data: data[0], customer, orole });
});

app.post("/update_punchinp_details", check_user_login, async (req, res) => {
    let d = req.body;
    await exe(`
        UPDATE punchingdept SET
            p_operator_name=$1, p_shift=$2, p_machine=$3, p_customer=$4,
            p_project_name=$5, p_set_name=$6, p_material=$7, p_sheetqty=$8,
            p_length=$9, p_width=$10, p_thickness=$11, p_totalweight=$12,
            p_start_time=$13, p_end_time=$14, p_time=$15, p_m_processtime=$16,
            p_mureason=$17, other_gmr=$18, p_mjustification=$19, p_rejectionqty=$20
        WHERE p_id=$21
    `, [
        d.p_operator_name, d.p_shift, d.p_machine, d.p_customer, d.p_project_name,
        d.p_set_name, d.p_material, d.p_sheetqty, d.p_length, d.p_width, d.p_thickness,
        d.p_totalweight, d.p_start_time, d.p_end_time, d.p_process_time, d.p_m_processtime,
        d.p_mureason, d.other_gmr, d.p_mjustification, d.p_rejectionqty, d.p_id
    ]);
    if (req.session.oname.role === "admin") res.redirect("/admin_punching_dashboard");
    else res.redirect("/punchingproductionrecord");
});

app.get("/punchingdelete/:id", check_user_login, async (req, res) => {
    let id = req.params.id;
    await exe("DELETE FROM punchingdept WHERE p_id=$1", [id]);
    if (req.session.oname.role === "admin") res.redirect("/admin_punching_dashboard");
    else res.redirect("/punchingproductionrecord");
});

app.get("/admin_punching_dashboard", check_user_login, async (req, res) => {
    let d = req.session.oname.oname;
    let records = await exe("SELECT * FROM punchingdept ORDER BY p_id DESC");
    let customer = await exe("SELECT * FROM customers");
    let material = await exe("SELECT * FROM material");
    let project = await exe("SELECT * FROM project");
    res.render("admin_punching_dashboard.ejs", { records, d, customer, material, project });
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`Server Running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
    await pool.end();
    console.log("Database pool closed");
    process.exit(0);
});