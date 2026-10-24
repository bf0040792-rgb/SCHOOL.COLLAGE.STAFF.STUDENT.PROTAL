// ============================================================================
// STUDENT PORTAL - NATIVE SUPABASE SDK v2 (@supabase/supabase-js)
// ----------------------------------------------------------------------------
// The legacy Firebase / Firestore adapter layer has been removed. Every query
// below is a native PostgREST call (select / insert / update / delete) made
// with the Supabase client that is created right here.
// The SDK itself is loaded from the CDN in student.html (window.supabase).
// ============================================================================
const supabaseUrl = 'https://ynlcbpxcsnfxqrogizns.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlubGNicHhjc25meHFyb2dpem5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MDMxNjMsImV4cCI6MjEwMzQ3OTE2M30.sx5iFeugOuLBt4pqt0-8_4VOGz1yWa7HQWl4NyGCWkE';

// Single native Supabase client for this portal.
// (`let` because the student login API hands out a school-scoped JWT: Supabase
// clients are immutable, so the client is rebuilt with that token on login and
// rebuilt again from the anon key on logout.)
let supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
    }
});

function rebuildSupabaseClient(accessToken) {
    const options = {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    };
    if (accessToken) options.global = { headers: { Authorization: `Bearer ${accessToken}` } };
    return window.supabase.createClient(supabaseUrl, supabaseKey, options);
}

// Bumped on every login/logout so a response that belongs to a previous student session
// can never be rendered into the current dashboard.
let studentSessionEpoch = 0;

// PostgREST reports JWT problems in the PGRST30x group (HTTP 401) and Supabase surfaces them
// as a PostgrestError, so a rejected/expired student token is detectable without a retry loop.
function isStudentAuthError(error) {
    if (!error) return false;
    const code = String(error.code || '').toUpperCase();
    if (/^PGRST30[0-3]$/.test(code)) return true;
    return /jwt|access token|token is expired|could not authenticate/i.test(`${error.message || ''} ${error.details || ''}`);
}

// Dedicated Supabase table holding one feature-control row per school.
const FEATURE_SETTINGS_TABLE = "feature_controls";

let currentSchoolId = "";
let currentStudentUser = null;
let currentStudentSchoolDoc = null;
window.currentFeatureSettings = {};

const DEFAULT_FEATURE_SETTINGS = {
    student: {
        profile: true, homework: true, fee: true, datesheet: true, attendance: true, sms: true,
        calendar: true, idcard: true, syllabus: true, 'fee-receipt': true, admit: true, gatepass: true,
        notifications: true, birthday: true, transport: true, 'study-material': true, result: true,
        leave: true, batchmate: true, circular: true, news: true, assignment: true, complaint: true,
        'online-classes': true, 'social-media': true
    }
};

const LEGACY_STUDENT_FEATURE_KEYS = {
    timetable: 'datesheet',
    notice: 'notifications',
    library: 'study-material',
    marks: 'result'
};

const studentFeatures = [
    { id: 'profile', title: 'Profile', icon: 'fa-user' },
    { id: 'homework', title: 'Homework', icon: 'fa-book-open' },
    { id: 'fee', title: 'Fee', icon: 'fa-indian-rupee-sign' },
    { id: 'datesheet', title: 'DateSheet', icon: 'fa-calendar-days' },
    { id: 'attendance', title: 'Attendance', icon: 'fa-calendar-check' },
    { id: 'sms', title: 'SMS', icon: 'fa-message' },
    { id: 'calendar', title: 'Calendar Planning', icon: 'fa-calendar' },
    { id: 'idcard', title: 'ID Card', icon: 'fa-id-card' },
    { id: 'syllabus', title: 'Syllabus', icon: 'fa-book' },
    { id: 'fee-receipt', title: 'Fee Receipt', icon: 'fa-receipt' },
    { id: 'admit', title: 'Admit Card', icon: 'fa-sparkles' },
    { id: 'gatepass', title: 'Gate Pass', icon: 'fa-ticket' },
    { id: 'notifications', title: 'Notifications', icon: 'fa-bell' },
    { id: 'birthday', title: 'Birthday', icon: 'fa-cake-candles' },
    { id: 'transport', title: 'Transport', icon: 'fa-bus' },
    { id: 'study-material', title: 'Study Material', icon: 'fa-graduation-cap' },
    { id: 'result', title: 'Result', icon: 'fa-chart-line' },
    { id: 'leave', title: 'Leave Request', icon: 'fa-calendar-xmark' },
    { id: 'batchmate', title: 'Batchmate', icon: 'fa-users' },
    { id: 'circular', title: 'Circular', icon: 'fa-paper-plane' },
    { id: 'news', title: 'News', icon: 'fa-newspaper' },
    { id: 'assignment', title: 'Assignment', icon: 'fa-clipboard-list' },
    { id: 'complaint', title: 'Complaint', icon: 'fa-wrench' },
    { id: 'online-classes', title: 'Online Classes', icon: 'fa-desktop' },
    { id: 'social-media', title: 'Social Media', icon: 'fa-share-nodes' }
];

function $(id) { return document.getElementById(id); }

function sanitizeHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function sanitizeUrl(url) {
    if (!url) return '';
    const clean = String(url).trim();
    if (/^(https?:|\/|data:image\/)/i.test(clean)) {
        return clean.replace(/"/g, '%22').replace(/'/g, '%27');
    }
    return '#';
}

function hydrateFeatureSettings(payload = {}) {
    const settings = JSON.parse(JSON.stringify(DEFAULT_FEATURE_SETTINGS));
    const source = payload.featureSettings || payload || {};
    if (source.student) settings.student = { ...settings.student, ...source.student };
    Object.entries(LEGACY_STUDENT_FEATURE_KEYS).forEach(([legacyKey, currentKey]) => {
        if (source.student && Object.prototype.hasOwnProperty.call(source.student, legacyKey)) {
            settings.student[currentKey] = source.student[legacyKey] !== false;
        }
    });
    return settings;
}

async function readSchoolFeatureSettings(schoolId) {
    if (!schoolId) return hydrateFeatureSettings();

    try {
        const { data: rpcData, error: rpcErr } = await supabaseClient.rpc("get_institution_feature_controls", { p_school_id: schoolId });
        if (!rpcErr && rpcData && Object.keys(rpcData).length > 0) {
            return hydrateFeatureSettings({ featureSettings: rpcData });
        }
    } catch (rpcEx) {
        console.warn("RPC get_institution_feature_controls warning in student portal:", rpcEx);
    }

    const { data: featureRow, error: featureError } = await supabaseClient
        .from(FEATURE_SETTINGS_TABLE)
        .select("*")
        .eq("schoolId", schoolId)
        .maybeSingle();
    if (featureError) console.error("Feature control lookup failed:", featureError);
    if (featureRow) return hydrateFeatureSettings(featureRow);

    const { data: schoolRow, error: schoolError } = await supabaseClient
        .from("schools")
        .select("*")
        .eq("id", schoolId)
        .maybeSingle();
    if (schoolError) console.error("School lookup failed:", schoolError);
    return schoolRow ? hydrateFeatureSettings(schoolRow) : hydrateFeatureSettings();
}

function getStudentFeatureToggleKey(featureId) {
    return LEGACY_STUDENT_FEATURE_KEYS[featureId] || featureId;
}

function showStudentError(message) {
    const errBox = $('loginErrorMsg');
    if (!errBox) return alert(message);
    errBox.innerText = message;
    errBox.style.display = 'block';
    setTimeout(() => { errBox.style.display = 'none'; }, 5000);
}

function formatDobForPassword(dob) {
    if (!dob) return "";
    const value = String(dob).trim();
    if (/^\d{8}$/.test(value)) return value;
    const parts = value.split("-");
    if (parts.length === 3) {
        if (parts[0].length === 4) return `${parts[2].padStart(2, '0')}${parts[1].padStart(2, '0')}${parts[0]}`;
        return `${parts[0].padStart(2, '0')}${parts[1].padStart(2, '0')}${parts[2]}`;
    }
    return value.replace(/\D/g, "");
}

function formatDobForDisplay(dob) {
    if (!dob) return "N/A";
    const parts = String(dob).split('-');
    return parts.length === 3 && parts[0].length === 4 ? `${parts[2]}-${parts[1]}-${parts[0]}` : String(dob);
}

function renderStudentFeatureGrid() {
    const container = $('student-feature-grid');
    if (!container) return;
    container.innerHTML = `<div class="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-y-8 gap-x-4 justify-items-center">
        ${studentFeatures.map(feature => {
        const key = getStudentFeatureToggleKey(feature.id);
        const enabled = window.currentFeatureSettings?.student ? window.currentFeatureSettings.student[key] !== false : true;
        return `<div class="flex flex-col items-center group ${enabled ? 'cursor-pointer' : 'cursor-not-allowed'}" onclick="window.handleStudentFeatureClick('${feature.id}')" style="opacity:${enabled ? '1' : '0.45'}; filter:${enabled ? 'none' : 'grayscale(1)'};">
                <div class="w-14 h-14 rounded-full bg-[#E3EBF3] shadow-[6px_6px_14px_#c1c9d2,-6px_-6px_14px_#ffffff] flex items-center justify-center" style="position:relative;">
                    <i class="fas ${feature.icon} text-[#1E3A8A]"></i>
                    ${enabled ? '' : '<span style="position:absolute; right:-4px; top:-4px; background:#ef4444; color:#fff; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px;"><i class="fas fa-lock"></i></span>'}
                </div>
                <span class="text-[10px] font-medium text-center mt-3 tracking-wide text-[#1E3A8A]" style="font-family:Inter,sans-serif;">${feature.title}</span>
            </div>`;
    }).join('')}
    </div>`;
}

window.openStudentView = (targetId) => {
    const mainGrid = $('student-main-grid');
    if (mainGrid) mainGrid.style.display = targetId === 'student-main-grid' ? 'block' : 'none';
    document.querySelectorAll('.student-view-section').forEach(el => { el.style.display = 'none'; });
    if (targetId !== 'student-main-grid') {
        const targetEl = $(targetId);
        if (targetEl) targetEl.style.display = 'block';
    }
};

window.handleStudentFeatureClick = (featureId) => {
    const key = getStudentFeatureToggleKey(featureId);
    if (window.currentFeatureSettings?.student && window.currentFeatureSettings.student[key] === false) {
        alert("⚠️ Facility Locked: This feature has been disabled by the administration for your institution. You can view this section, but active access is restricted.");
        return;
    }
    if (featureId === 'fee') return window.showStudentPaymentSection();
    if (featureId === 'idcard') return window.openStudentView('student-idcard-section');
    if (featureId === 'admit') return window.loadStudentAdmitCard();
    if (featureId === 'fee-receipt') return window.showStudentReceiptsSection();
    if (featureId === 'complaint') return window.openStudentView('student-complaint-section');
    
    // Dispatch to implementation functions
    if (featureId === 'homework') return window.loadStudentHomework();
    if (featureId === 'attendance') return window.loadStudentAttendance();
    if (featureId === 'result') return window.loadStudentResult();
    if (featureId === 'datesheet') return window.loadStudentDateSheet();
    if (featureId === 'notifications' || featureId === 'circular' || featureId === 'news') return window.loadStudentNotifications();
    if (featureId === 'transport') return window.loadStudentTransport();
    if (featureId === 'leave') return window.loadStudentLeave();
    if (featureId === 'gatepass') return window.loadStudentGatepass();
    if (featureId === 'assignment') return window.loadStudentAssignments();
    if (featureId === 'syllabus') return window.loadStudentSyllabus();
    if (featureId === 'study-material') return window.loadStudentStudyMaterial();
    if (featureId === 'online-classes') return window.loadStudentOnlineClasses();

    const feature = studentFeatures.find(f => f.id === featureId);
    const title = $('placeholder-title');
    if (title && feature) title.innerText = `${feature.title} Module Under Construction`;
    window.openStudentView('student-placeholder-section');
};

function renderInstitutionPicker(institutions) {
    let picker = $('student-institution-picker');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'student-institution-picker';
        const btn = $('doStudentLoginBtn');
        if (btn && btn.parentNode) {
            btn.parentNode.insertBefore(picker, btn);
        }
    }
    picker.style.display = 'block';
    picker.innerHTML = `
        <div style="background: rgba(30, 58, 138, 0.45); border: 1px solid rgba(255,255,255,0.25); border-radius: 12px; padding: 12px; margin-bottom: 14px; text-align: left;">
            <p style="color: #fde047; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px;">
                <i class="fas fa-university"></i> Multiple Accounts Detected — Select Institution:
            </p>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${institutions.map(inst => `
                    <button type="button" onclick="loginStudent('${sanitizeHtml(inst.schoolId)}')" style="background: rgba(255,255,255,0.95); color: #1e3a8a; font-weight: 700; font-size: 12px; padding: 10px 14px; border-radius: 8px; border: none; cursor: pointer; text-align: left; transition: all 0.2s;" onmouseover="this.style.background='#38bdf8'; this.style.color='#ffffff';" onmouseout="this.style.background='rgba(255,255,255,0.95)'; this.style.color='#1e3a8a';">
                        <div style="font-size: 12px; font-weight: 800;">${sanitizeHtml(inst.schoolName)}</div>
                        <div style="font-size: 11px; color: #475569; font-weight: 500; margin-top: 2px;">Class: ${sanitizeHtml(inst.studentClass || 'N/A')} • Reg: ${sanitizeHtml(inst.regNo || 'N/A')}</div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

async function loginStudent(selectedSchoolId = null) {
    const mobile = $('student-login-username')?.value.trim();
    const dobPassword = $('student-login-password')?.value.trim();
    const btn = $('doStudentLoginBtn');
    const picker = $('student-institution-picker');
    if (!mobile || !dobPassword) return showStudentError("Enter registered mobile number and DOB password.");
    if (btn) {
        btn.disabled = true;
        btn.querySelector('span').innerText = "Verifying...";
    }
    if (picker && !selectedSchoolId) picker.style.display = 'none';

    try {
        // Direct native Supabase RPC authentication
        const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('student_portal_login', {
            p_mobile: mobile,
            p_dob: dobPassword,
            p_school_id: selectedSchoolId || null
        });

        if (rpcErr) throw new Error(rpcErr.message || "Failed to communicate with authentication service.");

        if (!rpcRes.success) {
            if (rpcRes.requires_school_selection && Array.isArray(rpcRes.institutions)) {
                renderInstitutionPicker(rpcRes.institutions);
                if (btn) {
                    btn.disabled = false;
                    btn.querySelector('span').innerText = "Select Institution Below";
                }
                return;
            }
            throw new Error(rpcRes.error || "Invalid mobile number or date of birth.");
        }

        const data = rpcRes;
        const accessToken = data.token || '';
        sessionStorage.setItem('studentToken', accessToken);
        studentSessionEpoch += 1;

        currentStudentUser = data.student;
        currentSchoolId = data.student.schoolId;
        currentStudentSchoolDoc = data.school;
        window.currentFeatureSettings = hydrateFeatureSettings(data.featureSettings || {});
        loadStudentDashboard();
    } catch (error) {
        console.error("Student login error:", error);
        showStudentError(error.message || "Student login failed.");
    } finally {
        if (btn && (!picker || picker.style.display === 'none')) {
            btn.disabled = false;
            btn.querySelector('span').innerText = "Access Portal";
        }
    }
}

async function loadStudentDashboard() {
    $('student-login-wrapper') && ($('student-login-wrapper').style.display = 'none');
    $('student-dashboard-wrapper') && ($('student-dashboard-wrapper').style.display = 'block');
    if (currentSchoolId) {
        try {
            window.currentFeatureSettings = await readSchoolFeatureSettings(currentSchoolId);
        } catch (e) {
            console.warn("Feature sync warning in student load:", e);
        }
    }
    $('student-dash-school-name') && ($('student-dash-school-name').innerText = currentStudentSchoolDoc?.schoolName || "Portal");
    $('stu-display-name') && ($('stu-display-name').innerText = currentStudentUser?.name || "Student");
    $('banner-name') && ($('banner-name').innerText = currentStudentUser?.name || "N/A");
    $('banner-parentage') && ($('banner-parentage').innerText = currentStudentUser?.parentage || currentStudentUser?.fatherName || "N/A");
    $('banner-class') && ($('banner-class').innerText = currentStudentUser?.class || "N/A");
    $('banner-reg') && ($('banner-reg').innerText = currentStudentUser?.regNo || currentStudentUser?.rollNo || "N/A");
    $('banner-dob') && ($('banner-dob').innerText = formatDobForDisplay(currentStudentUser?.dob));
    $('banner-contact') && ($('banner-contact').innerText = currentStudentUser?.mobile || "N/A");
    $('banner-blood') && ($('banner-blood').innerText = currentStudentUser?.bloodGroup || "N/A");
    $('banner-emergency') && ($('banner-emergency').innerText = currentStudentUser?.emergencyNo || "N/A");
    const qrString = `Name: ${currentStudentUser?.name || 'N/A'}\nSchool: ${currentStudentSchoolDoc?.schoolName || 'N/A'}\nClass: ${currentStudentUser?.class || 'N/A'}\nReg: ${currentStudentUser?.regNo || 'N/A'}\nContact: ${currentStudentUser?.mobile || 'N/A'}`;
    $('stu-banner-qr') && ($('stu-banner-qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=' + encodeURIComponent(qrString));
    const photo = $('stu-banner-photo');
    const icon = $('stu-banner-photo-icon');
    if (currentStudentUser?.photoUrl && photo) {
        photo.src = currentStudentUser.photoUrl;
        photo.classList.remove('hidden');
        if (icon) icon.style.display = 'none';
    }
    // Phase A: surface the student's academic structure (department / program /
    // roll code) without touching the stable identity fields above.
    (async () => {
        try {
            if (!currentStudentUser || !currentStudentUser.id) return;
            let stuQuery = supabaseClient.from('students').select('departmentId, programId, rollCode').eq('id', currentStudentUser.id);
            if (currentSchoolId) stuQuery = stuQuery.eq('schoolId', currentSchoolId);
            const { data } = await stuQuery.maybeSingle();
            if (!data || (!data.departmentId && !data.programId && !data.rollCode)) return;
            let dept = '', prog = '';
            try {
                if (data.departmentId) { const r = await supabaseClient.from('vw_public_departments').select('name').eq('id', data.departmentId).maybeSingle(); dept = r.data ? r.data.name : ''; }
                if (data.programId) { const r = await supabaseClient.from('vw_public_programs').select('name').eq('id', data.programId).maybeSingle(); prog = r.data ? r.data.name : ''; }
            } catch (e) { /* views appear with the Phase A migration */ }
            const line = [dept, prog].filter(Boolean).join(' · ') + (data.rollCode ? ' · Roll Code: ' + data.rollCode : '');
            const host = $('student-idcard-section');
            if (host && line && !document.getElementById('stu-academic-line')) {
                const card = host.querySelector('.card');
                const div = document.createElement('div');
                div.id = 'stu-academic-line';
                div.style.cssText = 'margin:0 0 12px; color:#0d9488; font-weight:700; font-size:13px;';
                div.innerText = line;
                card.insertBefore(div, card.children[2] || null);
            }
        } catch (e) { console.error('Phase A student enrichment failed:', e); }
    })();

    const logo = $('student-school-logo');
    const logoUrl = currentStudentSchoolDoc?.schoolLogoUrl || currentStudentSchoolDoc?.logoUrl;
    if (logo && logoUrl) {
        logo.src = logoUrl;
        logo.style.display = 'inline-block';
    }
    $('stu-due-balance') && ($('stu-due-balance').innerText = currentStudentUser?.dueBalance || currentStudentUser?.feeDue || 0);
    renderStudentFeatureGrid();
    window.openStudentView('student-main-grid');
}

window.showStudentPaymentSection = () => {
    if (!currentStudentSchoolDoc?.paymentQrUrl || !currentStudentSchoolDoc?.upiId) {
        alert("The school has not configured the QR Payment System yet.");
        return;
    }
    window.openStudentView('student-payment-section');
    $('stu-qr-img') && ($('stu-qr-img').src = currentStudentSchoolDoc.paymentQrUrl);
    $('stu-upi-text') && ($('stu-upi-text').innerText = currentStudentSchoolDoc.upiId);
    const dueAmount = Number(currentStudentUser?.feeDue || currentStudentUser?.dueBalance || 0);
    const upiLink = `upi://pay?pa=${currentStudentSchoolDoc.upiId}&pn=${encodeURIComponent(currentStudentSchoolDoc.schoolName || 'School')}&am=${dueAmount > 0 ? dueAmount : 0}&cu=INR`;
    $('stu-upi-deep-link') && ($('stu-upi-deep-link').href = upiLink);
};

window.showStudentReceiptsSection = async () => {
    window.openStudentView('student-receipt-section');
    const tbody = $('stu-receipt-table-body');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:16px;">Loading receipts...</td></tr>`;
    
    try {
        const token = sessionStorage.getItem('studentToken');
        let receipts = [];
        if (token) {
            const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_module_records', {
                p_token: token,
                p_module: 'transactions'
            });
            if (!rpcErr && res && res.success && Array.isArray(res.records)) {
                receipts = res.records;
            }
        }
        if (receipts.length === 0 && currentStudentUser?.id) {
            const { data, error } = await supabaseClient
                .from("transactions")
                .select("*")
                .eq("schoolId", currentSchoolId)
                .eq("type", "Fee")
                .eq("studentId", currentStudentUser.id);
            if (!error && data) receipts = data;
        }
        if (!receipts || receipts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:16px; color:#64748b;">No receipts available.</td></tr>`;
            return;
        }
        let html = '';
        receipts.forEach(data => {
            html += `<tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 12px;">${sanitizeHtml(data.date || (data.createdAt ? new Date(data.createdAt).toLocaleDateString() : 'N/A'))}</td>
                <td style="padding: 12px; font-weight: bold; color: #10b981;">₹${sanitizeHtml(data.amount || 0)}</td>
                <td style="padding: 12px;"><span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 6px; font-size: 12px;">${sanitizeHtml(data.status || 'Paid')} (${sanitizeHtml(data.method || data.mode || 'Online')})</span></td>
            </tr>`;
        });
        tbody.innerHTML = html;
    } catch (err) {
        console.error("Error fetching receipts:", err);
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:16px; color:#ef4444;">Error loading receipts.</td></tr>`;
    }
};

window.submitStudentComplaint = async (event) => {
    event.preventDefault();
    const token = sessionStorage.getItem('studentToken');
    if (!token) return alert("Please login again.");
    const target = $('complaint-target')?.value;
    const subject = $('complaint-subject')?.value.trim();
    const description = $('complaint-desc')?.value.trim();
    if (!target || !subject || !description) return alert("Please fill all complaint fields.");
    
    try {
        const { data: res, error } = await supabaseClient.rpc('submit_student_complaint', {
            p_token: token,
            p_target: target,
            p_subject: subject,
            p_description: description
        });
        if (error || !res?.success) throw new Error(error?.message || res?.error || "Failed to submit complaint.");
        alert("Complaint submitted successfully.");
        event.target.reset();
        window.openStudentView('student-main-grid');
    } catch (err) {
        alert("Error submitting complaint: " + err.message);
    }
};

window.logoutStudent = () => {
    if (window.unsubStudent) window.unsubStudent();
    if (window.unsubSchool) window.unsubSchool();
    if (window.unsubStudentFeatureSettings) window.unsubStudentFeatureSettings();
    
    // Fully clear sensitive student state
    sessionStorage.removeItem('studentToken');
    supabaseClient = rebuildSupabaseClient();
    studentSessionEpoch += 1; // invalidate any in-flight response from this session
    currentStudentUser = null;
    currentStudentSchoolDoc = null;
    currentSchoolId = "";
    window.currentFeatureSettings = {};
    
    // Reset all DOM containers to empty strings to prevent data leakage between sessions
    const containers = [
        'stu-homework-container', 'stu-attendance-container', 'stu-result-container',
        'stu-datesheet-container', 'stu-notifications-container', 'stu-transport-container',
        'stu-leave-container', 'stu-gatepass-container', 'stu-assignment-container',
        'stu-syllabus-container', 'stu-studymaterial-container', 'stu-onlineclasses-container',
        'stu-receipt-table-body'
    ];
    containers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });

    $('student-dashboard-wrapper') && ($('student-dashboard-wrapper').style.display = 'none');
    $('student-login-wrapper') && ($('student-login-wrapper').style.display = 'flex');
    $('student-login-password') && ($('student-login-password').value = '');
};

// --- DATA FETCHING & UI RENDERING FUNCTIONS --- //

// Helper for UI loading/empty/error states
function setContainerState(containerId, state, message = '') {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (state === 'loading') {
        el.innerHTML = `<div class="p-8 text-center text-slate-500"><i class="fas fa-spinner fa-spin text-2xl mb-2"></i><p>Loading data...</p></div>`;
    } else if (state === 'empty') {
        el.innerHTML = `<div class="p-8 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-100"><i class="fas fa-folder-open text-3xl mb-3 text-slate-300"></i><p>${message || 'No records found.'}</p></div>`;
    } else if (state === 'error') {
        el.innerHTML = `<div class="p-8 text-center text-red-500 bg-red-50 rounded-xl border border-red-100"><i class="fas fa-exclamation-triangle text-3xl mb-3 opacity-70"></i><p>${message || 'Failed to load data.'}</p></div>`;
    }
}

// Helper query function ensuring schoolId isolation and real-time live data
async function fetchScopedData(tableName, additionalFilters = {}) {
    if (!currentSchoolId) throw new Error("Unauthenticated request blocked.");
    const token = sessionStorage.getItem('studentToken');
    if (token) {
        try {
            const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_module_records', {
                p_token: token,
                p_module: tableName,
                p_filters: additionalFilters
            });
            if (!rpcErr && res && res.success && Array.isArray(res.records)) {
                return res.records;
            }
        } catch (rpcEx) {
            console.warn("RPC get_student_module_records fallback for " + tableName, rpcEx);
        }
    }
    let request = supabaseClient.from(tableName).select("*").eq("schoolId", currentSchoolId);
    Object.entries(additionalFilters).forEach(([field, value]) => { request = request.eq(field, value); });
    const { data, error } = await request;
    if (error) throw error;
    return (data || []).map(row => (row && row.data) ? { ...row, ...row.data } : row);
}

window.loadStudentHomework = async () => {
    window.openStudentView('student-homework-section');
    setContainerState('stu-homework-container', 'loading');
    try {
        const data = await fetchScopedData('homework', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-homework-container', 'empty', 'There is no homework assigned for you right now.');
        
        let html = '';
        data.forEach(hw => {
            const safeFileUrl = sanitizeUrl(hw.fileUrl);
            html += `<div class="p-4 border border-gray-200 rounded-xl bg-gray-50 flex flex-col gap-2">
                <div class="flex justify-between items-start">
                    <span class="font-bold text-[#1E3A8A] text-lg">${sanitizeHtml(hw.subject || 'Subject')}</span>
                    <span class="text-xs font-semibold text-gray-500 bg-gray-200 px-2 py-1 rounded">Due: ${sanitizeHtml(hw.dueDate || 'N/A')}</span>
                </div>
                <h4 class="font-semibold text-gray-800">${sanitizeHtml(hw.title || 'Untitled Homework')}</h4>
                <p class="text-sm text-gray-600">${sanitizeHtml(hw.description || 'No description provided.')}</p>
                <div class="flex justify-between items-center mt-2 flex-wrap gap-2">
                    <span class="text-xs text-gray-500">Assigned by: ${sanitizeHtml(hw.teacherName || 'Teacher')}</span>
                    ${safeFileUrl !== '#' ? `<a href="${safeFileUrl}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 bg-indigo-600 text-white rounded text-xs font-semibold flex items-center gap-1 shadow hover:bg-indigo-700 transition"><i class="fas fa-paperclip"></i> View Worksheet</a>` : ''}
                </div>
            </div>`;
        });
        document.getElementById('stu-homework-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-homework-container', 'error');
    }
};

// `attendance_records` is normalized (one row per student per date), so the status comes
// straight from the row instead of a class-wide records map.
function normalizeStudentAttendanceStatus(status) {
    const value = String(status == null ? '' : status).trim().toLowerCase();
    return value === 'present' || value === 'absent' ? value : '';
}

function escapeStudentHtml(value) {
    const node = document.createElement('span');
    node.textContent = value == null || value === '' ? 'N/A' : String(value);
    return node.innerHTML;
}

window.loadStudentAttendance = async () => {
    window.openStudentView('student-attendance-section');
    setContainerState('stu-attendance-container', 'loading');
    const requestEpoch = studentSessionEpoch;
    try {
        if (!currentStudentUser?.id || !currentSchoolId) throw new Error("Unauthenticated request blocked.");

        const token = sessionStorage.getItem('studentToken');
        let studentRecords = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_module_records', {
                    p_token: token,
                    p_module: 'attendance'
                });
                if (!rpcErr && res && res.success && Array.isArray(res.records)) {
                    studentRecords = res.records;
                }
            } catch (rpcEx) {
                console.warn("RPC attendance fallback:", rpcEx);
            }
        }
        if (studentRecords.length === 0) {
            const { data: rows, error } = await supabaseClient
                .from('attendance_records')
                .select('date, status, class, updatedAt')
                .eq('schoolId', currentSchoolId)
                .eq('studentId', currentStudentUser.id)
                .order('date', { ascending: false })
                .limit(180);
            if (!error && rows) studentRecords = rows;
        }
        if (requestEpoch !== studentSessionEpoch) return; // logout / re-login happened mid-flight

        if (studentRecords.length === 0) return setContainerState('stu-attendance-container', 'empty', 'No attendance records found.');

        const presentCount = studentRecords.filter(att => normalizeStudentAttendanceStatus(att.status) === 'present').length;
        const absentCount = studentRecords.filter(att => normalizeStudentAttendanceStatus(att.status) === 'absent').length;
        const markedCount = presentCount + absentCount;
        const percentage = markedCount > 0 ? Math.round((presentCount / markedCount) * 100) : null;

        let html = `<div class="p-4 bg-green-50 border border-green-200 rounded-xl mb-4 text-center">
            <h4 class="text-green-800 font-bold text-lg mb-1">Attendance Records Found</h4>
            <p class="text-sm text-green-600">Showing your most recent attendance dates.</p>
            <p class="text-sm text-slate-600 mt-2">Present: <span class="font-bold text-green-700">${presentCount}</span> &bull; Absent: <span class="font-bold text-red-600">${absentCount}</span>${percentage === null ? '' : ` &bull; Attendance: <span class="font-bold text-[#1E3A8A]">${percentage}%</span>`}</p>
        </div><div class="grid grid-cols-2 md:grid-cols-4 gap-3">`;

        studentRecords.forEach(att => {
            const status = normalizeStudentAttendanceStatus(att.status);
            const badge = status === 'present'
                ? { css: 'bg-green-100 text-green-700', label: 'Present' }
                : status === 'absent'
                    ? { css: 'bg-red-100 text-red-700', label: 'Absent' }
                    : { css: 'bg-slate-100 text-slate-600', label: escapeStudentHtml(att.status) };
            html += `<div class="p-3 border border-gray-200 rounded-lg text-center bg-white shadow-sm">
                <div class="font-bold text-gray-800 text-sm mb-1">${escapeStudentHtml(att.date || 'Unknown Date')}</div>
                <div class="text-xs font-semibold px-2 py-1 rounded inline-block ${badge.css}">${badge.label}</div>
            </div>`;
        });
        html += `</div>`;
        document.getElementById('stu-attendance-container').innerHTML = html;
    } catch (e) {
        if (requestEpoch !== studentSessionEpoch) return;
        console.error("Student attendance load failed:", e);
        setContainerState('stu-attendance-container', 'error');
    }
};

window.loadStudentResult = async () => {
    window.openStudentView('student-result-section');
    setContainerState('stu-result-container', 'loading');
    try {
        const data = await fetchScopedData('exam_marks', { studentId: currentStudentUser.id });
        if (data.length === 0) return setContainerState('stu-result-container', 'empty', 'No result records found for you.');
        
        let html = '';
        data.forEach(res => {
            html += `<div class="p-4 border border-blue-100 rounded-xl bg-blue-50/30 flex justify-between items-center">
                <div>
                    <h4 class="font-bold text-blue-900">${sanitizeHtml(res.examName || 'Exam')}</h4>
                    <p class="text-sm text-slate-600">Subject: ${sanitizeHtml(res.subject || 'All Subjects')}</p>
                </div>
                <div class="text-right">
                    <div class="text-2xl font-black text-[#1E3A8A]">${sanitizeHtml(res.marksObtained || 0)}/${sanitizeHtml(res.totalMarks || 100)}</div>
                    <div class="text-xs font-semibold text-green-600">Status: ${sanitizeHtml(res.status || 'Published')}</div>
                </div>
            </div>`;
        });
        document.getElementById('stu-result-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-result-container', 'error');
    }
};

window.loadStudentDateSheet = async () => {
    window.openStudentView('student-datesheet-section');
    setContainerState('stu-datesheet-container', 'loading');
    try {
        const data = await fetchScopedData('datesheets', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-datesheet-container', 'empty', 'No datesheet currently published for your class.');
        
        let html = '';
        data.forEach(ds => {
            const safeFileUrl = sanitizeUrl(ds.fileUrl);
            html += `<div class="p-4 border border-gray-200 rounded-xl flex justify-between items-center shadow-sm flex-wrap gap-2">
                <div>
                    <h4 class="font-bold text-gray-800">${sanitizeHtml(ds.examName || 'Upcoming Exam')}</h4>
                    <p class="text-sm text-gray-500">Date: ${sanitizeHtml(ds.date || 'TBA')} | Time: ${sanitizeHtml(ds.time || 'TBA')}</p>
                    <div class="font-bold text-[#1E3A8A] mt-1">${sanitizeHtml(ds.subject || 'All Subjects')}</div>
                </div>
                <div>
                    ${safeFileUrl !== '#' ? `<a href="${safeFileUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 bg-emerald-600 text-white rounded font-semibold text-xs flex items-center gap-1.5 shadow hover:bg-emerald-700 transition"><i class="fas fa-file-pdf"></i> View Schedule</a>` : ''}
                </div>
            </div>`;
        });
        document.getElementById('stu-datesheet-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-datesheet-container', 'error');
    }
};

window.loadStudentNotifications = async () => {
    window.openStudentView('student-notifications-section');
    setContainerState('stu-notifications-container', 'loading');
    try {
        const data = await fetchScopedData('notices');
        // Only show notices targeted at 'All', 'Students', or specific class
        const validNotices = data.filter(n => !n.target || n.target === 'All' || n.target === 'Students' || n.target === currentStudentUser.class);
        if (validNotices.length === 0) return setContainerState('stu-notifications-container', 'empty', 'No new notifications or circulars.');
        
        let html = '';
        validNotices.forEach(n => {
            html += `<div class="p-4 border-l-4 border-[#1E3A8A] bg-gray-50 rounded-r-xl shadow-sm">
                <div class="flex justify-between items-start mb-2">
                    <h4 class="font-bold text-gray-800">${sanitizeHtml(n.title || 'Notification')}</h4>
                    <span class="text-xs text-gray-500">${sanitizeHtml(n.date || new Date(n.createdAt?.toDate?.() || Date.now()).toLocaleDateString())}</span>
                </div>
                <p class="text-sm text-gray-600 whitespace-pre-wrap">${sanitizeHtml(n.body || n.description || '')}</p>
            </div>`;
        });
        document.getElementById('stu-notifications-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-notifications-container', 'error');
    }
};

window.loadStudentTransport = async () => {
    window.openStudentView('student-transport-section');
    setContainerState('stu-transport-container', 'loading');
    try {
        const data = await fetchScopedData('bus_routes');
        // If there's a mapped route for this student
        const route = data.find(r => r.students && r.students.includes(currentStudentUser.id)) || data[0]; // fallback to showing school routes if none explicitly mapped
        
        if (!data || data.length === 0) return setContainerState('stu-transport-container', 'empty', 'No transport data mapped to your profile.');
        
        const html = `<div class="p-6 bg-yellow-50 border border-yellow-200 rounded-2xl shadow-sm text-center">
            <i class="fas fa-bus text-4xl text-yellow-500 mb-3"></i>
            <h4 class="font-bold text-yellow-800 text-xl mb-1">${sanitizeHtml(route?.routeName || 'School Bus Route')}</h4>
            <p class="text-sm text-yellow-700 mb-4">Vehicle Number: ${sanitizeHtml(route?.vehicleNo || 'TBA')}</p>
            <div class="grid grid-cols-2 gap-4 text-left">
                <div class="bg-white p-3 rounded-lg border border-yellow-100">
                    <div class="text-xs text-gray-500 font-semibold uppercase">Driver Name</div>
                    <div class="font-bold text-gray-800">${sanitizeHtml(route?.driverName || 'TBA')}</div>
                </div>
                <div class="bg-white p-3 rounded-lg border border-yellow-100">
                    <div class="text-xs text-gray-500 font-semibold uppercase">Driver Contact</div>
                    <div class="font-bold text-gray-800">${sanitizeHtml(route?.driverContact || 'TBA')}</div>
                </div>
            </div>
        </div>`;
        document.getElementById('stu-transport-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-transport-container', 'error');
    }
};

window.loadStudentLeave = async () => {
    window.openStudentView('student-leave-section');
    setContainerState('stu-leave-container', 'loading');
    try {
        const data = await fetchScopedData('leave_requests', { studentId: currentStudentUser.id });
        if (data.length === 0) return setContainerState('stu-leave-container', 'empty', 'You have not submitted any leave requests yet.');
        
        let html = '';
        data.forEach(req => {
            const statusColor = req.status === 'Approved' ? 'text-green-600 bg-green-100' : (req.status === 'Rejected' ? 'text-red-600 bg-red-100' : 'text-orange-600 bg-orange-100');
            html += `<div class="p-3 border border-gray-200 rounded-xl bg-white shadow-sm flex justify-between items-center">
                <div>
                    <div class="font-bold text-gray-800 text-sm">${sanitizeHtml(req.startDate)} to ${sanitizeHtml(req.endDate)}</div>
                    <div class="text-xs text-gray-500 mt-1">${sanitizeHtml(req.reason)}</div>
                </div>
                <div class="px-3 py-1 rounded-full text-xs font-bold ${statusColor}">${sanitizeHtml(req.status || 'Pending')}</div>
            </div>`;
        });
        document.getElementById('stu-leave-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-leave-container', 'error');
    }
};

window.submitStudentLeave = async (e) => {
    e.preventDefault();
    const token = sessionStorage.getItem('studentToken');
    if (!token) return alert("Session expired. Please login again.");
    const start = $('leave-start').value;
    const end = $('leave-end').value;
    const reason = $('leave-reason').value.trim();
    if (!start || !end || !reason) return alert("Fill all fields.");
    try {
        const { data: res, error } = await supabaseClient.rpc('submit_student_leave', {
            p_token: token,
            p_start_date: start,
            p_end_date: end,
            p_reason: reason
        });
        if (error || !res?.success) throw new Error(error?.message || res?.error || "Failed to submit request.");
        alert("Leave request submitted successfully.");
        e.target.reset();
        loadStudentLeave();
    } catch (err) {
        alert("Error: " + err.message);
    }
};

window.loadStudentGatepass = async () => {
    window.openStudentView('student-gatepass-section');
    setContainerState('stu-gatepass-container', 'loading');
    try {
        const data = await fetchScopedData('gate_passes', { studentId: currentStudentUser.id });
        if (data.length === 0) return setContainerState('stu-gatepass-container', 'empty', 'No gate passes requested.');
        
        let html = '';
        data.forEach(req => {
            const statusColor = req.status === 'Approved' ? 'text-green-600 bg-green-100' : (req.status === 'Rejected' ? 'text-red-600 bg-red-100' : 'text-gray-600 bg-gray-100');
            html += `<div class="p-3 border border-gray-200 rounded-xl bg-white shadow-sm flex justify-between items-center">
                <div>
                    <div class="font-bold text-gray-800 text-sm">${sanitizeHtml(new Date(req.dateTime).toLocaleString())}</div>
                    <div class="text-xs text-gray-500 mt-1">Reason: ${sanitizeHtml(req.reason)}</div>
                </div>
                <div class="px-3 py-1 rounded-full text-xs font-bold ${statusColor}">${sanitizeHtml(req.status || 'Pending')}</div>
            </div>`;
        });
        document.getElementById('stu-gatepass-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-gatepass-container', 'error');
    }
};

window.submitStudentGatepass = async (e) => {
    e.preventDefault();
    const token = sessionStorage.getItem('studentToken');
    if (!token) return alert("Session expired. Please login again.");
    const time = $('gatepass-time').value;
    const reason = $('gatepass-reason').value.trim();
    if (!time || !reason) return alert("Fill all fields.");
    try {
        const { data: res, error } = await supabaseClient.rpc('submit_student_gatepass', {
            p_token: token,
            p_date_time: new Date(time).toISOString(),
            p_reason: reason
        });
        if (error || !res?.success) throw new Error(error?.message || res?.error || "Failed to submit gate pass.");
        alert("Gate pass request submitted successfully.");
        e.target.reset();
        loadStudentGatepass();
    } catch (err) {
        alert("Error: " + err.message);
    }
};

window.loadStudentAssignments = async () => {
    window.openStudentView('student-assignment-section');
    setContainerState('stu-assignment-container', 'loading');
    try {
        const data = await fetchScopedData('assignments', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-assignment-container', 'empty', 'No assignments published for your class.');
        let html = '';
        data.forEach(a => {
            html += `<div class="p-4 border border-purple-200 bg-purple-50 rounded-xl shadow-sm">
                <div class="flex justify-between font-bold text-purple-900 mb-1"><span>${sanitizeHtml(a.subject || 'Subject')}</span> <span class="text-xs bg-white px-2 py-1 rounded text-purple-700">Deadline: ${sanitizeHtml(a.deadline || 'N/A')}</span></div>
                <h4 class="font-semibold text-gray-800 text-sm">${sanitizeHtml(a.title || 'Assignment')}</h4>
                <p class="text-xs text-gray-600 mt-2">${sanitizeHtml(a.description || 'No description provided.')}</p>
            </div>`;
        });
        document.getElementById('stu-assignment-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-assignment-container', 'error');
    }
};

window.loadStudentSyllabus = async () => {
    window.openStudentView('student-syllabus-section');
    setContainerState('stu-syllabus-container', 'loading');
    try {
        const data = await fetchScopedData('syllabus', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-syllabus-container', 'empty', 'Syllabus not available yet.');
        let html = '';
        data.forEach(s => {
            const safeFileUrl = sanitizeUrl(s.fileUrl);
            const titleDisplay = s.title ? `${sanitizeHtml(s.subject)} — ${sanitizeHtml(s.title)}` : sanitizeHtml(s.subject);
            html += `<div class="p-4 border border-gray-200 rounded-xl shadow-sm flex items-center justify-between flex-wrap gap-2">
                <div>
                    <h4 class="font-bold text-gray-800">${titleDisplay}</h4>
                    <p class="text-xs text-gray-500">Class / Semester: ${sanitizeHtml(s.class || currentStudentUser.class)}</p>
                </div>
                ${safeFileUrl !== '#' ? `<a href="${safeFileUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 bg-blue-600 text-white rounded font-semibold text-xs flex items-center gap-1.5 shadow hover:bg-blue-700 transition"><i class="fas fa-file-pdf"></i> View / Download</a>` : ''}
            </div>`;
        });
        document.getElementById('stu-syllabus-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-syllabus-container', 'error');
    }
};

window.loadStudentStudyMaterial = async () => {
    window.openStudentView('student-studymaterial-section');
    setContainerState('stu-studymaterial-container', 'loading');
    try {
        const data = await fetchScopedData('study_materials', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-studymaterial-container', 'empty', 'No study materials available.');
        let html = '';
        data.forEach(s => {
            const safeLink = sanitizeUrl(s.link);
            html += `<div class="p-4 border border-gray-200 rounded-xl shadow-sm">
                <h4 class="font-bold text-gray-800">${sanitizeHtml(s.title)}</h4>
                <p class="text-xs text-gray-500 mb-2">${sanitizeHtml(s.subject || '')}</p>
                ${safeLink !== '#' ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="text-blue-600 text-sm font-semibold underline">Open Material <i class="fas fa-external-link-alt ml-1"></i></a>` : ''}
            </div>`;
        });
        document.getElementById('stu-studymaterial-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-studymaterial-container', 'error');
    }
};

window.loadStudentOnlineClasses = async () => {
    window.openStudentView('student-onlineclasses-section');
    setContainerState('stu-onlineclasses-container', 'loading');
    try {
        const data = await fetchScopedData('online_classes', { class: currentStudentUser.class });
        if (data.length === 0) return setContainerState('stu-onlineclasses-container', 'empty', 'No online classes scheduled for today.');
        let html = '';
        data.forEach(c => {
            const safeLink = sanitizeUrl(c.link);
            html += `<div class="p-4 border border-teal-200 bg-teal-50 rounded-xl shadow-sm text-center">
                <i class="fas fa-video text-3xl text-teal-600 mb-2"></i>
                <h4 class="font-bold text-teal-900">${sanitizeHtml(c.subject || 'Live Class')}</h4>
                <p class="text-sm text-teal-700 mb-3">Time: ${sanitizeHtml(c.time || 'Scheduled')}</p>
                ${safeLink !== '#' ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="inline-block px-4 py-2 bg-teal-600 text-white rounded-lg font-bold text-sm hover:bg-teal-700"><i class="fas fa-play mr-1"></i> Join Class</a>` : ''}
            </div>`;
        });
        document.getElementById('stu-onlineclasses-container').innerHTML = html;
    } catch (e) {
        setContainerState('stu-onlineclasses-container', 'error');
    }
};

window.loadStudentAdmitCard = async () => {
    window.openStudentView('student-admitcard-section');
    const container = $('student-admitcard-section');
    if (!container) return;
    
    const token = sessionStorage.getItem('studentToken');
    if (!token) return alert("Please log in again.");

    container.innerHTML = `
        <button onclick="openStudentView('student-main-grid')" class="mb-4 flex items-center gap-2 text-slate-600 font-semibold no-print"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>
        <div class="card p-8 text-center text-slate-500 bg-white rounded-xl border border-slate-100">
            <i class="fas fa-spinner fa-spin text-3xl mb-3 text-[#1E3A8A]"></i>
            <p>Loading your Examination Admit Card...</p>
        </div>`;

    try {
        const { data: res, error } = await supabaseClient.rpc('get_student_admit_card_data', { p_token: token });
        if (error) throw error;
        if (!res.success) throw new Error(res.error || "Failed to load admit card.");

        const student = res.student;
        const school = res.school;
        const datesheets = res.datesheets || [];

        if (student.lockedOut || Number(student.dueBalance || student.feeDue || 0) > 0) {
            container.innerHTML = `
                <button onclick="openStudentView('student-main-grid')" class="mb-4 flex items-center gap-2 text-slate-600 font-semibold no-print"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>
                <div class="card" style="text-align: center; padding: 35px 20px; border-radius:16px; background:white; border-left: 6px solid #ef4444; box-shadow:0 4px 15px rgba(0,0,0,0.06);">
                    <i class="fas fa-lock" style="font-size: 42px; color: #ef4444; margin-bottom: 12px;"></i>
                    <h3 style="color: #991b1b; font-weight: 800; font-size: 20px; margin-bottom: 8px;">Admit Card Locked</h3>
                    <p style="color: #64748b; font-size: 14px; max-width: 480px; margin: 0 auto 16px;">Your Examination Admit Card has been temporarily locked due to pending institution dues (Balance: ₹${sanitizeHtml(String(student.dueBalance || student.feeDue || 0))}). Please clear your dues or contact administration to unlock.</p>
                </div>`;
            return;
        }

        let tableRows = '';
        if (datesheets.length > 0) {
            datesheets.forEach(ds => {
                tableRows += `<tr>
                    <td style="border: 1px solid #cbd5e1; padding: 10px; font-size: 13px;">${sanitizeHtml(ds.date || 'TBA')}</td>
                    <td style="border: 1px solid #cbd5e1; padding: 10px; font-size: 13px; font-weight: 600;">${sanitizeHtml(ds.subject || 'Subject')}</td>
                    <td style="border: 1px solid #cbd5e1; padding: 10px; font-size: 13px;">${sanitizeHtml(ds.time || '10:00 AM - 01:00 PM')}</td>
                </tr>`;
            });
        } else {
            tableRows = `<tr><td colspan="3" style="border: 1px solid #cbd5e1; padding: 14px; text-align: center; color: #64748b;">Examination schedule is being finalized by the examination cell.</td></tr>`;
        }

        const safeLogo = sanitizeUrl(school.logoUrl);
        const safePhoto = sanitizeUrl(student.photoUrl);
        const safeSign = sanitizeUrl(school.signatureUrl);

        container.innerHTML = `
            <button onclick="openStudentView('student-main-grid')" class="mb-4 flex items-center gap-2 text-slate-600 font-semibold no-print"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>
            <div id="printable-admit-card" style="background: white; border-radius: 16px; padding: 28px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 2px solid #0f172a; max-width: 820px; margin: 0 auto 20px;">
                <!-- Header -->
                <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 3px double #0f172a; padding-bottom: 14px; margin-bottom: 18px;">
                    ${safeLogo ? `<img src="${safeLogo}" style="width: 70px; height: 70px; object-fit: contain; border-radius: 8px;">` : `<div style="width:70px;"></div>`}
                    <div style="text-align: center; flex: 1; padding: 0 12px;">
                        <h2 style="font-size: 20px; font-weight: 900; color: #1E3A8A; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">${sanitizeHtml(school.schoolName || 'INSTITUTION NAME')}</h2>
                        <h3 style="font-size: 14px; font-weight: 800; color: #e67e22; margin: 4px 0 0; letter-spacing: 2px;">EXAMINATION ADMIT CARD</h3>
                        <p style="font-size: 11px; color: #64748b; margin: 2px 0 0;">ACADEMIC SESSION 2026-2027</p>
                    </div>
                    <div style="width: 70px; text-align: right;">
                        <img id="stu-admit-qr" src="https://api.qrserver.com/v1/create-qr-code/?size=70x70&data=${encodeURIComponent('Admit:' + (student.name || '') + '|' + (student.rollNo || '') + '|' + (school.schoolName || ''))}" style="width: 65px; height: 65px;">
                    </div>
                </div>

                <!-- Student Details Grid -->
                <div style="display: flex; justify-content: space-between; gap: 16px; margin-bottom: 20px;">
                    <div style="flex: 1; font-size: 13px; line-height: 1.8;">
                        <div><strong style="color: #475569;">Student Name:</strong> <span style="font-weight: 800; color: #0f172a;">${sanitizeHtml(student.name || '')}</span></div>
                        <div><strong style="color: #475569;">Parentage:</strong> <span style="font-weight: 600;">${sanitizeHtml(student.parentage || student.fatherName || 'N/A')}</span></div>
                        <div><strong style="color: #475569;">Class / Semester:</strong> <span style="font-weight: 700; color: #1E3A8A;">${sanitizeHtml(student.class || '')}</span></div>
                        <div><strong style="color: #475569;">Roll Number:</strong> <span style="font-weight: 800; color: #dc2626;">${sanitizeHtml(student.rollNo || 'N/A')}</span></div>
                        <div><strong style="color: #475569;">Registration No:</strong> <span style="font-weight: 700;">${sanitizeHtml(student.regNo || 'N/A')}</span></div>
                        <div><strong style="color: #475569;">Date of Birth:</strong> <span>${sanitizeHtml(formatDobForDisplay(student.dob))}</span></div>
                    </div>
                    <div style="width: 120px; text-align: center; flex-shrink: 0;">
                        ${safePhoto ? `<img src="${safePhoto}" style="width: 110px; height: 130px; object-fit: cover; border-radius: 8px; border: 2px solid #cbd5e1; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">` : `<div style="width: 110px; height: 130px; border: 2px dashed #94a3b8; display:flex; align-items:center; justify-content:center; color:#94a3b8; border-radius:8px;">Photo</div>`}
                    </div>
                </div>

                <!-- Datesheet / Subjects -->
                <div style="margin-bottom: 24px;">
                    <h4 style="font-size: 13px; font-weight: 700; color: #1E3A8A; margin-bottom: 8px; text-transform: uppercase;"><i class="fas fa-list-check"></i> Examination Schedule</h4>
                    <table style="width: 100%; border-collapse: collapse; text-align: left;">
                        <thead>
                            <tr style="background: #f1f5f9;">
                                <th style="border: 1px solid #cbd5e1; padding: 8px; font-size: 12px; color: #334155;">Exam Date</th>
                                <th style="border: 1px solid #cbd5e1; padding: 8px; font-size: 12px; color: #334155;">Subject / Paper</th>
                                <th style="border: 1px solid #cbd5e1; padding: 8px; font-size: 12px; color: #334155;">Timing</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                </div>

                <!-- Footer Signatures -->
                <div style="display: flex; justify-content: space-between; align-items: flex-end; padding-top: 16px; border-top: 1px solid #cbd5e1;">
                    <div style="text-align: center; width: 180px;">
                        <div style="height: 40px;"></div>
                        <div style="border-top: 1px solid #0f172a; padding-top: 4px; font-size: 12px; font-weight: 600;">Candidate Signature</div>
                    </div>
                    <div style="text-align: center; width: 180px;">
                        ${safeSign ? `<img src="${safeSign}" style="max-height: 40px; margin-bottom: 4px; display:inline-block;">` : `<div style="height: 40px;"></div>`}
                        <div style="border-top: 1px solid #0f172a; padding-top: 4px; font-size: 12px; font-weight: 700; color: #1E3A8A;">Controller of Examinations</div>
                    </div>
                </div>
            </div>
            <div style="text-align: center; margin-bottom: 24px;" class="no-print">
                <button onclick="window.print()" class="action-btn" style="background:#1E3A8A; color:white; padding: 12px 28px; font-size: 14px; font-weight: 700; border-radius: 10px; cursor: pointer;">
                    <i class="fas fa-print mr-2"></i> Print Admit Card / Save as PDF
                </button>
            </div>
        `;
    } catch (err) {
        console.error("Error loading admit card:", err);
        container.innerHTML = `
            <button onclick="openStudentView('student-main-grid')" class="mb-4 flex items-center gap-2 text-slate-600 font-semibold"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>
            <div class="card p-8 text-center text-red-500 bg-red-50 rounded-xl border border-red-100">
                <i class="fas fa-exclamation-triangle text-3xl mb-3 opacity-70"></i>
                <p>${err.message || 'Failed to load admit card.'}</p>
            </div>`;
    }
};

window.downloadStudentAdmitCard = () => {
    window.print();
};

window.downloadStudentIDCard = () => {
    window.print();
};

document.addEventListener('DOMContentLoaded', () => {
    $('doStudentLoginBtn')?.addEventListener('click', () => loginStudent());
    $('student-login-password')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') loginStudent();
    });
});


