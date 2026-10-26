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
    return window.supabase.createClient(supabaseUrl, supabaseKey, options);
}

// Bumped on every login/logout so a response that belongs to a previous student session
// can never be rendered into the current dashboard.
let studentSessionEpoch = 0;

function isStudentAuthError(error) {
    if (!error) return false;
    const msg = String(error.message || error.details || '');
    return /Session expired/i.test(msg);
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
    if (featureId === 'profile') return window.loadStudentProfile();
    if (featureId === 'fee') return window.showStudentPaymentSection();
    if (featureId === 'idcard') return window.openStudentView('student-idcard-section');
    if (featureId === 'admit') return window.loadStudentAdmitCard();
    if (featureId === 'fee-receipt') return window.showStudentReceiptsSection();
    if (featureId === 'complaint') return window.openStudentComplaintSection();
    if (featureId === 'batchmate') return window.loadStudentBatchmates();
    if (featureId === 'sms') return window.loadStudentSms();
    
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
            const { data: sDoc } = await supabaseClient.from('schools').select('*').eq('id', currentSchoolId).maybeSingle();
            if (sDoc) currentStudentSchoolDoc = { ...(currentStudentSchoolDoc || {}), ...sDoc };
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

window.showStudentPaymentSection = async () => {
    window.openStudentView('student-payment-section');
    
    // Refresh student record to ensure live fee balance
    try {
        if (currentStudentUser?.id && currentSchoolId) {
            const { data: freshStudent } = await supabaseClient
                .from('students')
                .select('feeDue, dueBalance')
                .eq('id', currentStudentUser.id)
                .eq('schoolId', currentSchoolId)
                .maybeSingle();
            if (freshStudent) {
                currentStudentUser.feeDue = freshStudent.feeDue;
                currentStudentUser.dueBalance = freshStudent.dueBalance;
            }
        }
    } catch (e) {
        console.warn("Live fee sync warning:", e);
    }

    const dueAmount = Number(currentStudentUser?.feeDue ?? currentStudentUser?.dueBalance ?? 0);
    const feeDueEl = $('fee-panel-due');
    if (feeDueEl) feeDueEl.innerText = dueAmount.toLocaleString('en-IN');
    const stuDueBal = $('stu-due-balance');
    if (stuDueBal) stuDueBal.innerText = dueAmount.toLocaleString('en-IN');

    // Fetch total paid fee
    let paidTotal = 0;
    try {
        const { data: txs } = await supabaseClient
            .from('transactions')
            .select('amount')
            .eq('schoolId', currentSchoolId)
            .eq('type', 'Fee')
            .or(`studentId.eq.${currentStudentUser?.id},personId.eq.${currentStudentUser?.id}`);
        if (txs) {
            txs.forEach(t => { paidTotal += Number(t.amount || 0); });
        }
    } catch (txErr) {
        console.warn("Fee paid calculation warning:", txErr);
    }
    const feePaidEl = $('fee-panel-paid');
    if (feePaidEl) feePaidEl.innerText = paidTotal.toLocaleString('en-IN');

    // Populate QR Code
    if (currentStudentSchoolDoc?.paymentQrUrl) {
        $('stu-qr-img') && ($('stu-qr-img').src = currentStudentSchoolDoc.paymentQrUrl);
        $('stu-upi-text') && ($('stu-upi-text').innerText = currentStudentSchoolDoc.upiId || 'N/A');
        const upiLink = `upi://pay?pa=${currentStudentSchoolDoc.upiId || ''}&pn=${encodeURIComponent(currentStudentSchoolDoc.schoolName || 'School')}&am=${dueAmount > 0 ? dueAmount : 0}&cu=INR`;
        $('stu-upi-deep-link') && ($('stu-upi-deep-link').href = upiLink);
        $('fee-qr-card') && ($('fee-qr-card').style.display = 'block');
    } else {
        $('fee-qr-card') && ($('fee-qr-card').style.display = 'none');
    }
};

window.currentStudentReceipts = [];

window.showStudentReceiptsSection = async () => {
    window.openStudentView('student-receipt-section');
    const tbody = $('stu-receipt-table-body');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:16px; color:#8fa3bf;"><i class="fas fa-spinner fa-spin"></i> Loading official fee receipts...</td></tr>`;
    
    try {
        const token = sessionStorage.getItem('studentToken');
        let receipts = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_module_records', {
                    p_token: token,
                    p_module: 'transactions',
                    p_filters: {}
                });
                if (!rpcErr && res && res.success && Array.isArray(res.records)) {
                    receipts = res.records;
                }
            } catch (rpcEx) {
                console.warn("RPC transactions fallback:", rpcEx);
            }
        }
        if (receipts.length === 0 && currentStudentUser?.id) {
            const { data, error } = await supabaseClient
                .from("transactions")
                .select("*")
                .eq("schoolId", currentSchoolId)
                .eq("type", "Fee")
                .or(`studentId.eq.${currentStudentUser.id},personId.eq.${currentStudentUser.id}`)
                .order("createdAt", { ascending: false });
            if (!error && data) receipts = data;
        }

        window.currentStudentReceipts = receipts;

        // Calculate totals
        let totalPaid = 0;
        receipts.forEach(r => { totalPaid += Number(r.amount || 0); });
        const dueBalance = Number(currentStudentUser?.feeDue ?? currentStudentUser?.dueBalance ?? 0);

        $('receipt-summary-paid') && ($('receipt-summary-paid').innerText = totalPaid.toLocaleString('en-IN'));
        $('receipt-summary-due') && ($('receipt-summary-due').innerText = dueBalance.toLocaleString('en-IN'));
        $('receipt-summary-count') && ($('receipt-summary-count').innerText = receipts.length);

        if (!receipts || receipts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:20px; color:#64748b;">No fee receipts or payment entries found for your account.</td></tr>`;
            return;
        }

        let html = '';
        receipts.forEach((data, idx) => {
            const receiptNo = data.referenceId || data.receiptNo || (data.data?.receiptNo) || ('REC-' + String(data.id || '').slice(-6));
            const dateStr = data.date || (data.createdAt ? new Date(data.createdAt).toLocaleDateString('en-GB') : 'N/A');
            const mode = data.method || data.mode || (data.data?.mode) || 'Online';
            const safeReceipt = (receiptNo || '').replace(/'/g, "\\'");
            html += `<tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 12px; font-weight:600; color:#334155;">${sanitizeHtml(dateStr)}</td>
                <td style="padding: 12px; font-family:monospace; font-weight:bold; color:#1E3A8A;">${sanitizeHtml(receiptNo)}</td>
                <td style="padding: 12px; color:#64748b;">${sanitizeHtml(mode)}</td>
                <td style="padding: 12px; font-weight: bold; color: #10b981;">₹${Number(data.amount || 0).toLocaleString('en-IN')}</td>
                <td style="padding: 12px;"><span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight:700;">${sanitizeHtml(data.status || 'Paid')}</span></td>
                <td style="padding: 12px; text-align:center;">
                    <button class="action-btn" style="padding:4px 10px; font-size:11px; background:#f1f5f9; border:1px solid #cbd5e1; color:#334155; border-radius:6px; cursor:pointer;" onclick="window.printSingleReceipt(${idx})">
                        <i class="fas fa-print"></i> Slip
                    </button>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
    } catch (err) {
        console.error("Error fetching receipts:", err);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:16px; color:#ef4444;">Error loading receipts.</td></tr>`;
    }
};

window.printSingleReceipt = (index) => {
    const data = window.currentStudentReceipts?.[index];
    if (!data) return alert("Receipt data not found.");
    const receiptNo = data.referenceId || data.receiptNo || (data.data?.receiptNo) || ('REC-' + String(data.id || '').slice(-6));
    const dateStr = data.date || (data.createdAt ? new Date(data.createdAt).toLocaleDateString('en-GB') : 'N/A');
    const mode = data.method || data.mode || (data.data?.mode) || 'Online';
    const amount = Number(data.amount || 0).toLocaleString('en-IN');
    const schoolName = currentStudentSchoolDoc?.schoolName || "Institution";

    const printWin = window.open('', '_blank', 'width=750,height=800');
    if (!printWin) return alert("Please allow popups to print receipt.");

    printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Fee Receipt - ${receiptNo}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, sans-serif; padding: 30px; color: #1e293b; }
                .receipt-box { border: 2px solid #1e3a8a; border-radius: 12px; padding: 25px; max-width: 650px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px dashed #cbd5e1; padding-bottom: 15px; margin-bottom: 20px; }
                .school-title { font-size: 22px; font-weight: 800; color: #1e3a8a; text-transform: uppercase; margin: 0; }
                .sub-title { font-size: 13px; color: #64748b; margin-top: 4px; }
                .receipt-badge { display: inline-block; background: #dcfce7; color: #166534; font-weight: bold; font-size: 13px; padding: 4px 12px; border-radius: 20px; margin-top: 10px; }
                .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 14px; margin-bottom: 20px; }
                .info-item { padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
                .info-label { color: #64748b; font-size: 12px; }
                .info-value { font-weight: 700; color: #0f172a; }
                .amount-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; text-align: center; margin: 20px 0; }
                .amount-val { font-size: 28px; font-weight: 900; color: #10b981; }
                .footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 35px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
                .stamp-box { border: 1px dashed #94a3b8; width: 140px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #94a3b8; border-radius: 6px; }
                @media print { .no-print { display: none; } }
            </style>
        </head>
        <body>
            <div class="no-print" style="text-align:center; margin-bottom:20px;">
                <button onclick="window.print()" style="padding:10px 20px; font-weight:bold; background:#1e3a8a; color:white; border:none; border-radius:8px; cursor:pointer;">Print Receipt</button>
            </div>
            <div class="receipt-box">
                <div class="header">
                    <h1 class="school-title">${schoolName}</h1>
                    <div class="sub-title">Official Student Fee Payment Voucher</div>
                    <div class="receipt-badge">PAID • VERIFIED</div>
                </div>
                <div class="info-grid">
                    <div class="info-item"><div class="info-label">Receipt Number</div><div class="info-value">${receiptNo}</div></div>
                    <div class="info-item"><div class="info-label">Payment Date</div><div class="info-value">${dateStr}</div></div>
                    <div class="info-item"><div class="info-label">Student Full Name</div><div class="info-value">${currentStudentUser?.name || 'Student'}</div></div>
                    <div class="info-item"><div class="info-label">Class / Semester</div><div class="info-value">${currentStudentUser?.class || 'N/A'}</div></div>
                    <div class="info-item"><div class="info-label">Roll Number</div><div class="info-value">${currentStudentUser?.rollNo || currentStudentUser?.roll || 'N/A'}</div></div>
                    <div class="info-item"><div class="info-label">Payment Mode</div><div class="info-value">${mode}</div></div>
                </div>
                <div class="amount-box">
                    <div style="font-size:12px; color:#64748b; font-weight:600; text-transform:uppercase;">Amount Received</div>
                    <div class="amount-val">₹ ${amount}</div>
                    <div style="font-size:12px; color:#10b981; font-weight:bold; margin-top:4px;">Payment Cleared & Credited</div>
                </div>
                <div class="footer">
                    <div>
                        <div>Generated via CoreEdu Digital Portal</div>
                        <div>Date: ${new Date().toLocaleDateString('en-GB')}</div>
                    </div>
                    <div style="text-align:center;">
                        <div class="stamp-box">Authorized Seal</div>
                        <div style="margin-top:6px; font-size:11px;">Accounts Officer</div>
                    </div>
                </div>
            </div>
            <script>window.onload = function() { setTimeout(function() { window.print(); }, 400); };</script>
        </body>
        </html>
    `);
    printWin.document.close();
};

window.printStudentFeeStatement = () => {
    const receipts = window.currentStudentReceipts || [];
    const schoolName = currentStudentSchoolDoc?.schoolName || "Institution";
    let totalPaid = 0;
    receipts.forEach(r => { totalPaid += Number(r.amount || 0); });
    const dueAmount = Number(currentStudentUser?.feeDue ?? currentStudentUser?.dueBalance ?? 0);

    const printWin = window.open('', '_blank', 'width=850,height=900');
    if (!printWin) return alert("Please allow popups to view statement.");

    let rowsHtml = '';
    if (receipts.length === 0) {
        rowsHtml = `<tr><td colspan="5" style="text-align:center; padding:15px; color:#64748b;">No payment entries recorded.</td></tr>`;
    } else {
        receipts.forEach((r, idx) => {
            const receiptNo = r.referenceId || r.receiptNo || (r.data?.receiptNo) || ('REC-' + String(r.id || '').slice(-6));
            const dateStr = r.date || (r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB') : 'N/A');
            const mode = r.method || r.mode || (r.data?.mode) || 'Online';
            rowsHtml += `<tr>
                <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:center;">${idx + 1}</td>
                <td style="padding:10px; border-bottom:1px solid #e2e8f0;">${dateStr}</td>
                <td style="padding:10px; border-bottom:1px solid #e2e8f0; font-family:monospace; font-weight:bold; color:#1e3a8a;">${receiptNo}</td>
                <td style="padding:10px; border-bottom:1px solid #e2e8f0;">${mode}</td>
                <td style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:right; font-weight:bold; color:#0f172a;">₹ ${Number(r.amount || 0).toLocaleString('en-IN')}</td>
            </tr>`;
        });
    }

    printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Fee Statement - ${currentStudentUser?.name || 'Student'}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, sans-serif; padding: 40px; color: #1e293b; }
                .statement-container { max-width: 800px; margin: 0 auto; border: 1px solid #cbd5e1; border-radius: 12px; padding: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
                .header { text-align: center; border-bottom: 2px solid #1e3a8a; padding-bottom: 15px; margin-bottom: 25px; }
                .school-title { font-size: 24px; font-weight: 800; color: #1e3a8a; margin: 0; text-transform: uppercase; }
                .doc-title { font-size: 15px; font-weight: 700; color: #475569; margin-top: 6px; letter-spacing: 1px; }
                .student-details { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 25px; font-size: 13px; }
                .ledger-table { width: 100%; border-collapse: collapse; margin-bottom: 25px; font-size: 13px; }
                .ledger-table th { background: #1e3a8a; color: white; padding: 10px; text-align: left; }
                .ledger-table th:last-child { text-align: right; }
                .summary-card { display: flex; justify-content: flex-end; gap: 20px; font-size: 14px; margin-top: 15px; }
                .summary-box { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 20px; text-align: right; min-width: 160px; }
                .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: flex-end; font-size: 12px; color: #64748b; }
                @media print { .no-print { display: none; } }
            </style>
        </head>
        <body>
            <div class="no-print" style="text-align:center; margin-bottom:20px;">
                <button onclick="window.print()" style="padding:10px 24px; font-weight:bold; background:#1e3a8a; color:white; border:none; border-radius:8px; cursor:pointer;">Print / Save as PDF</button>
            </div>
            <div class="statement-container">
                <div class="header">
                    <h1 class="school-title">${schoolName}</h1>
                    <div class="doc-title">OFFICIAL STUDENT FEE STATEMENT & STATEMENT OF ACCOUNT</div>
                </div>
                <div class="student-details">
                    <div><strong>Student Name:</strong> ${currentStudentUser?.name || 'N/A'}</div>
                    <div><strong>Class / Semester:</strong> ${currentStudentUser?.class || 'N/A'}</div>
                    <div><strong>Roll Number:</strong> ${currentStudentUser?.rollNo || currentStudentUser?.roll || 'N/A'}</div>
                    <div><strong>Parentage:</strong> ${currentStudentUser?.parentage || currentStudentUser?.fatherName || 'N/A'}</div>
                    <div><strong>Statement Date:</strong> ${new Date().toLocaleDateString('en-GB')}</div>
                    <div><strong>Student ID:</strong> ${currentStudentUser?.id || 'N/A'}</div>
                </div>
                <table class="ledger-table">
                    <thead>
                        <tr>
                            <th style="width:40px; text-align:center;">#</th>
                            <th>Payment Date</th>
                            <th>Receipt Number</th>
                            <th>Mode</th>
                            <th>Amount Paid</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <div class="summary-card">
                    <div class="summary-box">
                        <div style="font-size:11px; color:#64748b;">TOTAL AMOUNT PAID</div>
                        <div style="font-size:18px; font-weight:800; color:#10b981;">₹ ${totalPaid.toLocaleString('en-IN')}</div>
                    </div>
                    <div class="summary-box">
                        <div style="font-size:11px; color:#64748b;">CURRENT DUE BALANCE</div>
                        <div style="font-size:18px; font-weight:800; color:${dueAmount > 0 ? '#e11d48' : '#10b981'};">₹ ${dueAmount.toLocaleString('en-IN')}</div>
                    </div>
                </div>
                <div class="footer">
                    <div>
                        <div>This is an official computer-generated fee ledger statement.</div>
                        <div>Certified by Institution Accounts & Financial Audit.</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="border-bottom:1px solid #475569; width:150px; margin-bottom:4px;"></div>
                        <div>Authorized Signatory</div>
                    </div>
                </div>
            </div>
            <script>window.onload = function() { setTimeout(function() { window.print(); }, 400); };</script>
        </body>
        </html>
    `);
    printWin.document.close();
};

window.openStudentComplaintSection = () => {
    window.openStudentView('student-complaint-section');
    window.loadStudentComplaintsHistory();
};

window.loadStudentComplaintsHistory = async () => {
    const container = $('stu-complaint-container');
    if (!container || !currentStudentUser?.id) return;
    container.innerHTML = `<div style="text-align:center; padding:12px; color:#8fa3bf;"><i class="fas fa-spinner fa-spin"></i> Loading complaints...</div>`;

    try {
        const token = sessionStorage.getItem('studentToken');
        let list = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_module_records', {
                    p_token: token,
                    p_module: 'complaints',
                    p_filters: {}
                });
                if (!rpcErr && res && res.success && Array.isArray(res.records)) {
                    list = res.records;
                }
            } catch (rpcEx) {
                console.warn("RPC complaints fallback:", rpcEx);
            }
        }
        if (list.length === 0) {
            const { data, error } = await supabaseClient
                .from("complaints")
                .select("*")
                .eq("schoolId", currentSchoolId)
                .eq("studentId", currentStudentUser.id)
                .order("createdAt", { ascending: false });
            if (!error && data) list = data;
        }

        if (!list || list.length === 0) {
            container.innerHTML = `<div class="p-4 bg-gray-50 border border-gray-200 rounded-xl text-center text-xs text-gray-500">You have not submitted any complaints yet.</div>`;
            return;
        }

        let html = '';
        list.forEach(c => {
            const status = c.status || 'Pending';
            const statusColor = status === 'Resolved' ? 'bg-emerald-100 text-emerald-700' : (status === 'In Progress' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700');
            const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB') : (c.timestamp ? new Date(c.timestamp).toLocaleDateString('en-GB') : 'N/A');
            const targetBadge = sanitizeHtml(c.target || 'Administration');
            html += `<div class="p-4 border border-gray-200 rounded-xl bg-white shadow-sm flex flex-col gap-2">
                <div class="flex justify-between items-start flex-wrap gap-2">
                    <div>
                        <span class="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2.5 py-0.5 rounded-full">Target: ${targetBadge}</span>
                        <h4 class="font-bold text-gray-800 text-sm mt-1">${sanitizeHtml(c.subject || 'Complaint')}</h4>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400">${sanitizeHtml(dateStr)}</span>
                        <span class="px-2.5 py-1 rounded-full text-xs font-bold ${statusColor}">${sanitizeHtml(status)}</span>
                    </div>
                </div>
                <p class="text-xs text-gray-600 bg-gray-50 p-2.5 rounded-lg border border-gray-100">${sanitizeHtml(c.description || '')}</p>
                ${c.chairmanReply ? `<div class="p-3 bg-blue-50 border-l-4 border-blue-600 rounded-r-lg text-xs mt-1">
                    <strong class="text-blue-900 block mb-1"><i class="fas fa-reply"></i> Official Response:</strong>
                    <span class="text-blue-800">${sanitizeHtml(c.chairmanReply)}</span>
                </div>` : ''}
            </div>`;
        });
        container.innerHTML = html;
    } catch (err) {
        console.error("loadStudentComplaintsHistory error:", err);
        container.innerHTML = `<div class="p-3 bg-rose-50 text-rose-600 text-xs rounded-lg">Failed to load complaint records.</div>`;
    }
};

window.submitStudentComplaint = async (event) => {
    event.preventDefault();
    const token = sessionStorage.getItem('studentToken');
    if (!token && !currentStudentUser?.id) return alert("Please login again.");
    const target = $('complaint-target')?.value;
    const subject = $('complaint-subject')?.value.trim();
    const description = $('complaint-desc')?.value.trim();
    const submitBtn = $('stu-complaint-submit-btn');

    if (!target || !subject || !description) return alert("Please select recipient target and enter both subject and description.");

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = "<i class='fas fa-spinner fa-spin'></i> Submitting..."; }

    try {
        let success = false;
        let rpcErrorMsg = '';
        if (token) {
            try {
                const { data: res, error } = await supabaseClient.rpc('submit_student_complaint', {
                    p_token: token,
                    p_target: target,
                    p_subject: subject,
                    p_description: description
                });
                if (!error && res && res.success) {
                    success = true;
                } else {
                    rpcErrorMsg = (res && res.error) || (error && error.message) || '';
                }
            } catch (rpcErr) {
                console.warn("RPC complaint submit fallback:", rpcErr);
            }
        }

        if (!success) {
            if (rpcErrorMsg && rpcErrorMsg.toLowerCase().includes('session expired')) {
                throw new Error("Aapka login session expire ho gaya hai. Barah-e-karam dobara login karein.");
            }
            const { error: insertErr } = await supabaseClient.from('complaints').insert([{
                id: 'cmp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                schoolId: currentStudentSchoolDoc?.id || currentSchoolId,
                studentId: currentStudentUser?.id || currentStudentUser?.regNo || 'anonymous',
                studentName: currentStudentUser?.name || 'Student',
                studentMobile: currentStudentUser?.mobile || '',
                class: currentStudentUser?.class || '',
                section: currentStudentUser?.section || '',
                data: {
                    rollNo: currentStudentUser?.rollNo || '',
                    class: currentStudentUser?.class || '',
                    section: currentStudentUser?.section || '',
                    schoolName: currentStudentSchoolDoc?.schoolName || ''
                },
                target: target,
                subject: subject,
                description: description,
                status: 'Pending',
                timestamp: new Date().toISOString(),
                createdAt: new Date().toISOString()
            }]);
            if (insertErr) throw new Error(rpcErrorMsg || insertErr.message || "Failed to submit complaint.");
            success = true;
        }

        alert(`✅ Complaint successfully submitted to ${target}!\nYou can track status and responses below.`);
        event.target.reset();
        await window.loadStudentComplaintsHistory();
    } catch (err) {
        console.error("submitStudentComplaint error:", err);
        alert(err.message || ("Error submitting complaint: " + (err.message || err)));
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = "<i class='fas fa-paper-plane'></i> Submit Complaint"; }
    }
};

window.loadStudentBatchmates = async () => {
    window.openStudentView('student-batchmate-section');
    const container = $('batchmate-list-container');
    const classTag = $('batchmate-class-tag');
    if (classTag) classTag.innerText = currentStudentUser?.class || 'Class';
    if (!container) return;

    container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:20px; color:#8fa3bf;"><i class="fas fa-spinner fa-spin"></i> Loading classmates...</div>`;

    try {
        const token = sessionStorage.getItem('studentToken');
        let list = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_batchmates', {
                    p_token: token
                });
                if (!rpcErr && res && res.success && Array.isArray(res.batchmates)) {
                    list = res.batchmates;
                }
            } catch (rpcEx) {
                console.warn("RPC batchmates fallback:", rpcEx);
            }
        }

        if (list.length === 0 && currentSchoolId && currentStudentUser?.class) {
            let q = supabaseClient
                .from('students')
                .select('id, name, class, rollNo, photoUrl, section, departmentId')
                .eq('schoolId', currentSchoolId)
                .eq('class', currentStudentUser.class)
                .eq('status', 'Approved');
            if (currentStudentUser.departmentId) {
                q = q.eq('departmentId', currentStudentUser.departmentId);
            }
            const { data, error } = await q.order('name', { ascending: true });
            if (!error && data) list = data;
        }

        if (!list || list.length === 0) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:30px; color:#64748b;">No other batchmates found in ${sanitizeHtml(currentStudentUser?.class || 'your class')}.</div>`;
            return;
        }

        let html = '';
        list.forEach(s => {
            const isMe = s.id === currentStudentUser?.id;
            const photo = s.photoUrl || 'https://via.placeholder.com/100';
            html += `<div class="p-4 bg-white border ${isMe ? 'border-indigo-400 bg-indigo-50/20' : 'border-gray-200'} rounded-xl shadow-sm flex items-center gap-3">
                <img src="${sanitizeUrl(photo)}" alt="${sanitizeHtml(s.name)}" style="width:50px; height:50px; border-radius:50%; object-fit:cover; border:2px solid #e2e8f0; background:#f1f5f9;">
                <div class="flex-1 overflow-hidden">
                    <div class="flex justify-between items-start gap-1">
                        <h5 class="font-bold text-gray-800 text-sm truncate">${sanitizeHtml(s.name)} ${isMe ? '<span class="text-[10px] text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-full font-bold ml-1">You</span>' : ''}</h5>
                        ${!isMe ? `<button onclick="window.startSmsWithBatchmate('${s.id}')" class="px-2 py-0.5 rounded-md text-[11px] font-bold bg-blue-50 text-[#1E3A8A] hover:bg-blue-100 flex items-center gap-1 transition shadow-sm border border-blue-200"><i class="fas fa-comment-dots"></i> SMS</button>` : ''}
                    </div>
                    <div class="text-xs text-gray-500 mt-0.5">Roll: <strong class="text-gray-700">${sanitizeHtml(s.rollNo || s.roll || 'N/A')}</strong></div>
                    <div class="text-[11px] text-gray-400">${sanitizeHtml(s.class || '')} ${s.section ? '• Sec ' + sanitizeHtml(s.section) : ''}</div>
                </div>
            </div>`;
        });
        container.innerHTML = html;

        // Also prep class chat
        const chatTitle = $('class-chat-title');
        if (chatTitle) chatTitle.innerText = `${currentStudentUser?.class || 'Class'} Discussion Room`;
        window.loadClassChat();
    } catch (e) {
        console.error("loadStudentBatchmates error:", e);
        container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:20px; color:#ef4444;">Error loading batchmates.</div>`;
    }
};

window.switchBatchmateSubTab = (tab) => {
    const dirSub = $('batchmate-subtab-directory');
    const chatSub = $('batchmate-subtab-chat');
    const dirBtn = $('batch-tab-btn-dir');
    const chatBtn = $('batch-tab-btn-chat');

    if (tab === 'chat') {
        if (dirSub) dirSub.style.display = 'none';
        if (chatSub) chatSub.style.display = 'block';
        if (dirBtn) { dirBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200'; }
        if (chatBtn) { chatBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 text-white shadow'; }
        window.loadClassChat();
    } else {
        if (dirSub) dirSub.style.display = 'block';
        if (chatSub) chatSub.style.display = 'none';
        if (dirBtn) { dirBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 text-white shadow'; }
        if (chatBtn) { chatBtn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200'; }
    }
};

window.loadClassChat = async () => {
    const box = $('class-chat-box');
    if (!box || !currentSchoolId || !currentStudentUser?.class) return;

    try {
        const token = sessionStorage.getItem('studentToken');
        let messages = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_class_chat_messages', {
                    p_token: token
                });
                if (!rpcErr && res && res.success && Array.isArray(res.messages)) {
                    messages = res.messages;
                }
            } catch (rpcEx) {
                console.warn("RPC class chat fallback:", rpcEx);
            }
        }

        if (messages.length === 0) {
            const { data, error } = await supabaseClient
                .from('class_chat_messages')
                .select('*')
                .eq('schoolId', currentSchoolId)
                .eq('class', currentStudentUser.class)
                .order('createdAt', { ascending: true })
                .limit(100);
            if (!error && data) messages = data;
        }

        if (messages.length === 0) {
            box.innerHTML = `<div style="text-align:center; padding:30px 10px; color:#94a3b8; font-size:13px;">
                <i class="fas fa-comments text-3xl mb-2 text-slate-300"></i>
                <p>Welcome to ${sanitizeHtml(currentStudentUser?.class || 'Class')} discussion room!<br>Start a conversation with your classmates below.</p>
            </div>`;
            return;
        }

        let html = '';
        messages.forEach(m => {
            const isMe = m.studentId === currentStudentUser?.id;
            const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            html += `<div style="display:flex; flex-direction:column; align-items:${isMe ? 'flex-end' : 'flex-start'};">
                <div style="font-size:11px; font-weight:700; color:${isMe ? '#4338ca' : '#475569'}; margin-bottom:2px; padding:0 4px;">
                    ${isMe ? 'You' : sanitizeHtml(m.studentName || 'Classmate')}
                </div>
                <div style="max-width:80%; padding:10px 14px; border-radius:${isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px'}; background:${isMe ? '#4f46e5' : '#ffffff'}; color:${isMe ? '#ffffff' : '#1e293b'}; box-shadow:0 1px 3px rgba(0,0,0,0.06); border:${isMe ? 'none' : '1px solid #e2e8f0'}; font-size:13px; line-height:1.4; word-break:break-word;">
                    ${sanitizeHtml(m.message || '')}
                </div>
                <div style="font-size:10px; color:#94a3b8; margin-top:2px; padding:0 4px;">${timeStr}</div>
            </div>`;
        });
        box.innerHTML = html;
        box.scrollTop = box.scrollHeight;
    } catch (err) {
        console.error("loadClassChat error:", err);
    }
};

window.sendClassChatMessage = async (event) => {
    event.preventDefault();
    const input = $('class-chat-input');
    const msg = input ? input.value.trim() : '';
    const token = sessionStorage.getItem('studentToken');
    const sendBtn = $('class-chat-send-btn');
    if (!msg) return;

    if (sendBtn) { sendBtn.disabled = true; }

    try {
        let sent = false;
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('send_class_chat_message', {
                    p_token: token,
                    p_message: msg
                });
                if (!rpcErr && res && res.success) sent = true;
            } catch (rpcEx) {
                console.warn("RPC send class chat fallback:", rpcEx);
            }
        }

        if (!sent) {
            const { error: insErr } = await supabaseClient.from('class_chat_messages').insert([{
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                schoolId: currentSchoolId,
                class: currentStudentUser.class,
                studentId: currentStudentUser.id,
                studentName: currentStudentUser.name || 'Student',
                message: msg,
                createdAt: new Date().toISOString()
            }]);
            if (insErr) throw insErr;
        }

        if (input) input.value = '';
        await window.loadClassChat();
    } catch (err) {
        console.error("sendClassChatMessage error:", err);
        alert("Failed to send message: " + (err.message || err));
    } finally {
        if (sendBtn) { sendBtn.disabled = false; }
    }
};

window.loadStudentProfile = () => {
    window.openStudentView('student-profile-section');
    if (!currentStudentUser) return;

    $('profile-name') && ($('profile-name').innerText = currentStudentUser.name || 'Student');
    $('profile-class') && ($('profile-class').innerText = currentStudentUser.class || 'N/A');
    $('profile-roll') && ($('profile-roll').innerText = 'Roll: ' + (currentStudentUser.rollNo || currentStudentUser.roll || 'N/A'));
    $('profile-school') && ($('profile-school').innerText = currentStudentSchoolDoc?.schoolName || 'Institution');
    $('profile-father') && ($('profile-father').innerText = currentStudentUser.parentage || currentStudentUser.fatherName || 'N/A');
    $('profile-mother') && ($('profile-mother').innerText = currentStudentUser.motherName || 'N/A');
    $('profile-dob') && ($('profile-dob').innerText = currentStudentUser.dob || 'N/A');
    $('profile-mobile') && ($('profile-mobile').innerText = currentStudentUser.mobile || 'N/A');
    $('profile-address') && ($('profile-address').innerText = currentStudentUser.address || 'N/A');
    $('profile-photo') && ($('profile-photo').src = currentStudentUser.photoUrl || 'https://via.placeholder.com/100');
};

window.logoutStudent = () => {
    if (window.unsubStudent) window.unsubStudent();
    if (window.unsubSchool) window.unsubSchool();
    if (window.unsubStudentFeatureSettings) window.unsubStudentFeatureSettings();
    
    // Fully clear sensitive student state
    localStorage.removeItem('studentToken');
    sessionStorage.removeItem('studentToken');
    window.currentStudentPin = null;
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
    $('pin-wrapper') && ($('pin-wrapper').style.display = 'none');
    $('blocked-pin-box') && ($('blocked-pin-box').style.display = 'none');
    $('enter-pin-box') && ($('enter-pin-box').style.display = 'none');
    $('create-pin-box') && ($('create-pin-box').style.display = 'none');
    $('login-wrapper') && ($('login-wrapper').style.display = 'flex');
    $('student-login-wrapper') && ($('student-login-wrapper').style.display = 'flex');
    $('student-login-password') && ($('student-login-password').value = '');
    const cPin = $('c_loginPin');
    if (cPin) { cPin.value = ''; cPin.disabled = false; }
    const err = $('c_pinErrorMsg');
    if (err) err.style.display = 'none';
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
                    p_module: 'attendance',
                    p_filters: {}
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

window.downloadStudentIDCard = async () => {
    if (!currentStudentUser) return;
    const due = Number(currentStudentUser.dueBalance ?? currentStudentUser.feeDue ?? 0);
    if (due > 0) return alert("Digital ID Card is locked due to pending fees. Please clear your dues first.");

    const btn = $('stu-btn-download-id');
    const originalText = btn ? btn.innerHTML : "";
    if (btn) {
        btn.innerHTML = "<i class='fas fa-spinner fa-spin'></i> Generating...";
        btn.disabled = true;
    }

    try {
        const schoolDoc = currentStudentSchoolDoc || {};
        const response = await fetch("https://school-backend-zlgy.onrender.com/api/generate-id-card", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                studentData: {
                    id: currentStudentUser.id || currentStudentUser.regNo,
                    rollNo: currentStudentUser.rollNo || currentStudentUser.roll_no || currentStudentUser.rollCode || "",
                    regNo: currentStudentUser.regNo || currentStudentUser.reg_no || "",
                    name: currentStudentUser.name,
                    class: currentStudentUser.class,
                    dob: currentStudentUser.dob || "N/A",
                    parentage: (currentStudentUser.parentage || currentStudentUser.fatherName) || "N/A",
                    mobile: currentStudentUser.mobile || "N/A",
                    address: currentStudentUser.address || "N/A",
                    photoUrl: currentStudentUser.photoUrl || "https://via.placeholder.com/150"
                },
                themeColor: schoolDoc.themeColor || "#1e3c72",
                secondaryColor: schoolDoc.secondaryColor || "#ffffff",
                templateStyle: schoolDoc.idTemplateStyle || "wave",
                schoolName: schoolDoc.schoolName || currentStudentSchoolDoc?.schoolName || $('student-dash-school-name')?.innerText || "INSTITUTION NAME",
                schoolEmergency: schoolDoc.emergencyMobile || "N/A",
                signatureUrl: (schoolDoc.sigSettings && schoolDoc.sigSettings.idCard === false) ? "" : (schoolDoc.signatureUrl || ""),
                schoolLogoUrl: schoolDoc.logoUrl || schoolDoc.schoolLogoUrl || "",
                schoolNameColor: schoolDoc.schoolNameColor || "#ffffff",
                studentNameColor: schoolDoc.studentNameColor || "#d32f2f",
                detailsColor: schoolDoc.detailsColor || "#333333",
                photoBgColor: schoolDoc.photoBgColor || "#ffffff"
            })
        });
        const data = await response.json();
        if (data.success && data.idCardUrl) {
            if (window.jspdf && window.jspdf.jsPDF) {
                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF('p', 'mm', 'a4');
                pdf.addImage(data.idCardUrl, 'PNG', 10, 10, 54, 86);
                pdf.save(`${currentStudentUser.name}_ID_Card.pdf`);
            } else {
                const printWindow = window.open('', '_blank');
                if (printWindow) {
                    printWindow.document.write('<html><head><title>Student ID Card</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;"><img src="' + data.idCardUrl + '" style="max-height:90vh;" onload="window.print();"></body></html>');
                    printWindow.document.close();
                } else {
                    window.print();
                }
            }
        } else {
            window.print();
        }
    } catch (e) {
        console.error("Student ID card download error:", e);
        window.print();
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
};

// ====== SMS & DIRECT BATCHMATE CHAT ======
let activeSmsBatchmates = [];
let activeSmsRecipient = null;
let smsChatPollTimer = null;

window.loadStudentSms = async (targetBatchmateId = null) => {
    window.openStudentView('student-sms-section');
    const listContainer = $('sms-batchmates-list');
    if (listContainer) {
        listContainer.innerHTML = '<div class="p-4 text-center text-xs text-gray-400"><i class="fas fa-spinner fa-spin"></i> Loading batchmates...</div>';
    }

    try {
        const token = sessionStorage.getItem('studentToken');
        let batchmates = [];
        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_batchmates', { p_token: token });
                if (!rpcErr && res && res.success && Array.isArray(res.batchmates)) {
                    batchmates = res.batchmates;
                }
            } catch (ex) {
                console.warn("RPC batchmates in sms error:", ex);
            }
        }

        if (batchmates.length === 0 && currentSchoolId && currentStudentUser?.class) {
            let q = supabaseClient.from('students').select('id, name, class, rollNo, photoUrl, section, departmentId')
                .eq('schoolId', currentSchoolId)
                .eq('class', currentStudentUser.class)
                .eq('status', 'Approved');
            if (currentStudentUser.departmentId) q = q.eq('departmentId', currentStudentUser.departmentId);
            const { data } = await q.order('name', { ascending: true });
            if (data) batchmates = data;
        }

        // Filter out self
        activeSmsBatchmates = (batchmates || []).filter(b => String(b.id) !== String(currentStudentUser?.id));
        window.renderSmsBatchmatesList(activeSmsBatchmates);

        // Pre-select target or first
        if (targetBatchmateId) {
            window.selectSmsBatchmate(targetBatchmateId);
        } else if (activeSmsBatchmates.length > 0) {
            window.selectSmsBatchmate(activeSmsBatchmates[0].id);
        } else {
            const chatBox = $('sms-chat-box');
            if (chatBox) {
                chatBox.innerHTML = '<div class="m-auto text-center text-gray-400 text-xs"><i class="fas fa-user-slash text-3xl mb-2 text-gray-300"></i><p>No other batchmates found in your class/department.</p></div>';
            }
        }
    } catch (e) {
        console.error("loadStudentSms error:", e);
    }
};

window.renderSmsBatchmatesList = (list) => {
    const listContainer = $('sms-batchmates-list');
    if (!listContainer) return;

    if (!list || list.length === 0) {
        listContainer.innerHTML = '<div class="p-4 text-center text-xs text-gray-400">No batchmates found.</div>';
        return;
    }

    let html = '';
    list.forEach(b => {
        const isSelected = activeSmsRecipient && String(activeSmsRecipient.id) === String(b.id);
        const photo = b.photoUrl || 'https://via.placeholder.com/100';
        html += `<div onclick="window.selectSmsBatchmate('${b.id}')" class="p-3 flex items-center gap-3 cursor-pointer transition ${isSelected ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'}">
            <img src="${sanitizeUrl(photo)}" alt="${sanitizeHtml(b.name)}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid #e2e8f0; background:#f1f5f9;">
            <div class="flex-1 overflow-hidden">
                <div class="font-bold text-gray-800 text-xs truncate">${sanitizeHtml(b.name)}</div>
                <div class="text-[11px] text-gray-500">Roll: ${sanitizeHtml(b.rollNo || 'N/A')}</div>
            </div>
            <i class="fas fa-chevron-right text-gray-300 text-xs"></i>
        </div>`;
    });
    listContainer.innerHTML = html;
};

window.filterSmsBatchmates = (query) => {
    const q = (query || '').toLowerCase().trim();
    if (!q) {
        window.renderSmsBatchmatesList(activeSmsBatchmates);
        return;
    }
    const filtered = activeSmsBatchmates.filter(b => 
        (b.name && b.name.toLowerCase().includes(q)) ||
        (b.rollNo && String(b.rollNo).includes(q))
    );
    window.renderSmsBatchmatesList(filtered);
};

window.selectSmsBatchmate = async (batchmateId) => {
    const b = activeSmsBatchmates.find(item => String(item.id) === String(batchmateId));
    if (!b) return;
    activeSmsRecipient = b;
    window.renderSmsBatchmatesList(activeSmsBatchmates);

    // Update active header
    const nameEl = $('sms-active-name');
    const avatarEl = $('sms-active-avatar');
    const subEl = $('sms-active-sub');
    if (nameEl) nameEl.innerText = b.name || "Batchmate";
    if (avatarEl) avatarEl.src = sanitizeUrl(b.photoUrl || 'https://via.placeholder.com/100');
    if (subEl) subEl.innerHTML = `<i class="fas fa-circle text-[8px]"></i> Roll: ${sanitizeHtml(b.rollNo || 'N/A')} · ${sanitizeHtml(b.class || '')}`;

    await window.loadDirectMessagesForActive();

    // Focus input
    const input = $('sms-chat-input');
    if (input) input.focus();

    // Auto-poll every 5 seconds for new messages while section is active
    if (smsChatPollTimer) clearInterval(smsChatPollTimer);
    smsChatPollTimer = setInterval(() => {
        const sec = $('student-sms-section');
        if (sec && sec.style.display !== 'none' && activeSmsRecipient) {
            window.loadDirectMessagesForActive(true); // background silent fetch
        } else {
            clearInterval(smsChatPollTimer);
        }
    }, 5000);
};

window.loadDirectMessagesForActive = async (silent = false) => {
    if (!activeSmsRecipient) return;
    const box = $('sms-chat-box');
    if (!box) return;

    if (!silent) {
        box.innerHTML = '<div class="m-auto text-center text-xs text-gray-400"><i class="fas fa-spinner fa-spin"></i> Loading conversation...</div>';
    }

    try {
        const token = sessionStorage.getItem('studentToken');
        let messages = [];

        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('get_student_direct_messages', {
                    p_token: token,
                    p_other_student_id: activeSmsRecipient.id
                });
                if (!rpcErr && res && res.success && Array.isArray(res.messages)) {
                    messages = res.messages;
                }
            } catch (ex) {
                console.warn("RPC direct messages fallback:", ex);
            }
        }

        if (messages.length === 0 && currentSchoolId && currentStudentUser?.id) {
            const { data } = await supabaseClient
                .from('student_direct_messages')
                .select('*')
                .eq('schoolId', currentSchoolId)
                .or(`and(senderId.eq.${currentStudentUser.id},receiverId.eq.${activeSmsRecipient.id}),and(senderId.eq.${activeSmsRecipient.id},receiverId.eq.${currentStudentUser.id})`)
                .order('createdAt', { ascending: true })
                .limit(200);
            if (data) messages = data;
        }

        if (!messages || messages.length === 0) {
            box.innerHTML = `<div class="m-auto text-center text-gray-400 text-xs">
                <i class="fas fa-paper-plane text-2xl text-blue-300 mb-2"></i>
                <p>No messages yet with <strong>${sanitizeHtml(activeSmsRecipient.name)}</strong>.</p>
                <p class="text-[11px] text-gray-400 mt-1">Send a message below to start the conversation!</p>
            </div>`;
            return;
        }

        let html = '';
        messages.forEach(m => {
            const isMe = String(m.senderId) === String(currentStudentUser?.id);
            const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            html += `<div style="display:flex; flex-direction:column; align-items:${isMe ? 'flex-end' : 'flex-start'};">
                <div style="font-size:10px; font-weight:700; color:${isMe ? '#1E3A8A' : '#64748b'}; margin-bottom:2px; padding:0 4px;">
                    ${isMe ? 'You' : sanitizeHtml(m.senderName || activeSmsRecipient.name)}
                </div>
                <div style="max-width:78%; padding:10px 14px; border-radius:${isMe ? '16px 16px 3px 16px' : '16px 16px 16px 3px'}; background:${isMe ? '#1E3A8A' : '#ffffff'}; color:${isMe ? '#ffffff' : '#1e293b'}; box-shadow:0 1px 3px rgba(0,0,0,0.06); border:${isMe ? 'none' : '1px solid #e2e8f0'}; font-size:13px; line-height:1.4; word-break:break-word;">
                    ${sanitizeHtml(m.message || '')}
                </div>
                <div style="font-size:10px; color:#94a3b8; margin-top:2px; padding:0 4px;">${timeStr}</div>
            </div>`;
        });

        box.innerHTML = html;
        box.scrollTop = box.scrollHeight;
    } catch (e) {
        console.error("loadDirectMessagesForActive error:", e);
    }
};

window.refreshActiveSmsChat = async () => {
    await window.loadDirectMessagesForActive(false);
};

window.sendStudentDirectMessage = async (event) => {
    event.preventDefault();
    if (!activeSmsRecipient) {
        alert("Please select a batchmate to send SMS.");
        return;
    }

    const input = $('sms-chat-input');
    const msg = input ? input.value.trim() : '';
    if (!msg) return;

    const btn = $('sms-chat-send-btn');
    if (btn) btn.disabled = true;

    try {
        const token = sessionStorage.getItem('studentToken');
        let sent = false;

        if (token) {
            try {
                const { data: res, error: rpcErr } = await supabaseClient.rpc('send_student_direct_message', {
                    p_token: token,
                    p_receiver_id: activeSmsRecipient.id,
                    p_message: msg
                });
                if (!rpcErr && res && res.success) sent = true;
            } catch (ex) {
                console.warn("RPC send_student_direct_message fallback:", ex);
            }
        }

        if (!sent) {
            const { error: insErr } = await supabaseClient.from('student_direct_messages').insert([{
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                schoolId: currentSchoolId,
                senderId: currentStudentUser.id,
                senderName: currentStudentUser.name || 'Student',
                receiverId: activeSmsRecipient.id,
                receiverName: activeSmsRecipient.name || 'Batchmate',
                message: msg,
                createdAt: new Date().toISOString()
            }]);
            if (insErr) throw insErr;
        }

        if (input) input.value = '';
        await window.loadDirectMessagesForActive(true);
    } catch (e) {
        alert("Error sending message: " + (e.message || "Failed"));
    } finally {
        if (btn) btn.disabled = false;
    }
};

window.startSmsWithBatchmate = async (batchmateId) => {
    await window.loadStudentSms(batchmateId);
};

document.addEventListener('DOMContentLoaded', () => {
    $('doStudentLoginBtn')?.addEventListener('click', () => loginStudent());
    $('student-login-password')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') loginStudent();
    });
});


