// ============================================================================
// PUBLIC ADMISSION FORM - NATIVE SUPABASE SDK v2 (@supabase/supabase-js)
// ----------------------------------------------------------------------------
// The legacy Firebase / Firestore adapter layer is gone: this form now talks
// to Supabase directly through PostgREST (table queries) and GoTrue auth.
// The SDK itself is loaded from the CDN in admission.html (window.supabase).
// ============================================================================
const supabaseUrl = 'https://ynlcbpxcsnfxqrogizns.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlubGNicHhjc25meHFyb2dpem5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MDMxNjMsImV4cCI6MjEwMzQ3OTE2M30.sx5iFeugOuLBt4pqt0-8_4VOGz1yWa7HQWl4NyGCWkE';

const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
    }
});

// DOM Elements
const container = document.getElementById("admission-container");
const msgBox = document.getElementById("message-box");
const msgIcon = document.getElementById("msg-icon");
const msgTitle = document.getElementById("msg-title");
const msgText = document.getElementById("msg-text");

const schoolNameEl = document.getElementById("school-name");
const schoolLogoEl = document.getElementById("school-logo");
const form = document.getElementById("admission-form");
const submitBtn = document.getElementById("submit-btn");

let currentSchoolId = "";
let currentInstitutionType = "school";
let collegeChoice = null;
    async function initializeForm() {
    const urlParams = new URLSearchParams(window.location.search);
    currentSchoolId = urlParams.get('school');

    if (!currentSchoolId) {
        showError("Invalid Link", "School ID is missing in the URL.");
        return;
    }

    try {
        const { data: schoolData, error } = await supabaseClient
            .from('vw_public_schools')
            .select('schoolName, logoUrl, institution_type, admissionOpen')
            .eq('id', currentSchoolId)
            .maybeSingle();

        if (error || !schoolData) {
            showError("School Not Found", "The requested school could not be found.");
            return;
        }

        currentInstitutionType = schoolData.institution_type || "school";
        schoolNameEl.innerText = schoolData.schoolName || "School Admission";
        
        if (schoolData.logoUrl) {
            schoolLogoEl.src = schoolData.logoUrl;
            schoolLogoEl.style.display = "block";
        }
        
        document.title = (schoolData.schoolName || "Admission Form") + " - Admission Form";

        if (schoolData.admissionOpen === false) {
            showError("Admissions Closed", "Admissions are currently closed for this institution.");
            return;
        }

        if (currentInstitutionType === "college") {
            await loadCollegeStructure();
        } else {
            const classSelect = document.getElementById("student-class");
            if (classSelect) {
                const classes = ["Nursery", "LKG", "UKG", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"];
                let html = "<option value=''>-- Select Class --</option>";
                classes.forEach(c => html += `<option value="${c}">${c}</option>`);
                classSelect.innerHTML = html;
            }
        }

        container.style.display = "block"; form.style.display = "block"; msgBox.style.display = "none";

    } catch (err) {
        showError("Error", "Failed to load admission form.");
    }
}

function showError(title, message) {
    container.style.display = "block";
    form.style.display = "none";
    msgBox.style.display = "block";
    msgIcon.className = "fas fa-exclamation-circle error-icon";
    msgTitle.innerText = title;
    msgTitle.className = "error-title";
    msgText.innerText = message;
}

function showMessage(title, message, type="success") {
    container.style.display = "block";
    form.style.display = "none";
    msgBox.style.display = "block";
    msgIcon.className = type === "success" ? "fas fa-check-circle success-icon" : "fas fa-exclamation-circle error-icon";
    msgTitle.innerText = title;
    msgTitle.className = type === "success" ? "success-title" : "error-title";
    msgText.innerText = message;
}

async function uploadToCloudinary(file) {
    if (!file) return null;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", "coreedu");
    formData.append("cloud_name", "dffaw6gys");

    try {
        const res = await fetch("https://api.cloudinary.com/v1_1/dffaw6gys/image/upload", {
            method: "POST",
            body: formData,
        });
        const data = await res.json();
        return data.secure_url;
    } catch (err) {
        console.error("Cloudinary error:", err);
        return null;
    }
}

async function loadCollegeStructure() {
    const classSelect = document.getElementById("student-class");
    if (!classSelect) return;
    try {
        const semesters = ["1st Semester", "2nd Semester", "3rd Semester", "4th Semester", "5th Semester", "6th Semester"];
        let options = `<option value="">-- Select Semester --</option>`;
        semesters.forEach(s => options += `<option value="${s}">${s}</option>`);
        classSelect.innerHTML = options;

        const { data: deptsData } = await supabaseClient.from("vw_public_departments").select("id, name, code").eq("schoolId", currentSchoolId);
        let depts = deptsData || [];

        const oldGroup = document.getElementById("department-selection-group");
        if (oldGroup) oldGroup.remove();
        const oldSubjectGroup = document.getElementById("subject-selection-group");
        if (oldSubjectGroup) oldSubjectGroup.remove();

        let classGroup = classSelect.closest(".form-group");
        let deptHtml = `<div class="form-group" id="department-selection-group" style="margin-top: 15px;">
            <label for="student-department">Major Subject (Department) *</label>
            <select id="student-department" required style="width:100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; background: #f9f9f9;">
                <option value="">-- Select Major --</option>
        `;
        depts.forEach(d => {
            deptHtml += `<option value="${d.id}">${d.name} (${d.code})</option>`;
        });
        deptHtml += `</select></div>`;
        
        classGroup.insertAdjacentHTML("afterend", deptHtml);
    } catch (e) {
        console.error("Failed to load college structure for admission:", e);
    }
}

// 3. Form Submission
form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("student-name").value.trim();
    const dob = document.getElementById("student-dob").value;
    const rollNo = document.getElementById("roll-no").value.trim();
    const studentClass = document.getElementById("student-class").value;
    collegeChoice = null;
    let selectedSubjects = [];
    let departmentId = null;
    if (currentInstitutionType === "college") {
        const deptSelect = document.getElementById("student-department");
        if (deptSelect) departmentId = deptSelect.value;
    }
    const parentage = document.getElementById("parentage").value.trim();
    const motherName = document.getElementById("mother-name").value.trim();
    const mobile = document.getElementById("mobile").value.trim();
    const address = document.getElementById("address").value.trim();
    const photoFile = document.getElementById("photo").files[0];

    if (!name || !studentClass || !parentage || !motherName || !mobile || !address || !photoFile) {
        alert("Please fill in all required fields and upload a photo.");
        return;
    }

    // Set loading state
    submitBtn.disabled = true;
    submitBtn.innerHTML = "<i class='fas fa-spinner fa-spin'></i> Submitting...";

    try {
        // Upload photo
        const photoUrl = await uploadToCloudinary(photoFile);
        
        if (!photoUrl) {
            throw new Error("Image upload failed");
        }

        // Use secure RPC for admission submission
        const payload = {
            subjects: selectedSubjects,
            name: name,
            dob: dob,
            rollNo: rollNo,
            class: studentClass,
            parentage: parentage,
            motherName: motherName,
            mobile: mobile,
            address: address,
            photoUrl: photoUrl
        };

        const rpcName = currentInstitutionType === 'college' ? 'submit_admission_v2' : 'submit_admission';
        if (collegeChoice) {
            payload.departmentId = collegeChoice.departmentId;
            payload.programId = collegeChoice.programId;
        }
        const { data: result, error: rpcError } = await supabaseClient.rpc(rpcName, {
            p_school_id: currentSchoolId,
            p_payload: payload
        });

        if (rpcError) {
            console.error("RPC Error:", rpcError);
            if (rpcError.message && rpcError.message.includes('closed')) {
                throw new Error("Admissions are currently closed for this school.");
            }
            throw new Error(rpcError.message || "Failed to submit admission form");
        }

        // Show Success
        showMessage(
            "Success!", 
            "Admission Form Submitted Successfully! The school will contact you shortly.", 
            "success"
        );

    } catch (error) {
        console.error("Submission error:", error);
        alert("An error occurred while submitting your application. Please try again.");
        
        // Reset button
        submitBtn.disabled = false;
        submitBtn.innerHTML = "<i class='fas fa-paper-plane'></i> Submit Application";
    }
});







initializeForm();



