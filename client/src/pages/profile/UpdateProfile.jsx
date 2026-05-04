import { useState, useRef, useEffect } from "react"; // profile-v2
import { FiUploadCloud, FiEdit2, FiSave, FiX, FiLink, FiCheckCircle, FiLock, FiEye, FiEyeOff, FiPlus, FiMail, FiTrash2 } from "react-icons/fi";
import { useScrollAnimation } from "../../hooks/useScrollAnimation";
import * as pdfjsLib from 'pdfjs-dist';
import { profileService } from "../../services/profileService";
import "./UpdateProfile.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export default function UpdateProfile() {
  const [completionProgress, setCompletionProgress] = useState(65);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Auto-filled uneditable details
  const [basicInfo, setBasicInfo] = useState({
    firstName: "",
    lastName: "",
    email: "",
    role: "",
    photo: ""
  });

  const [editBasic, setEditBasic] = useState(false);

  // Resume Upload State
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeLink, setResumeLink] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const fileInputRef = useRef(null);
  const photoInputRef = useRef(null);

  // Extracted/Editable fields
  const [profileData, setProfileData] = useState({
    about: "",
    skills: [],
    education: [],
    projects: [],
    experience: [],
    certifications: [],
    codingProfiles: { github: "", leetcode: "", codechef: "" },
    achievements: "",
    connectedMails: []
  });

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        setIsLoading(true);
        const response = await profileService.getProfile();
        if (response.success) {
          setBasicInfo(response.data.basicInfo);
          setProfileData(response.data.profileData);
        }
      } catch (error) {
        console.error("Failed to fetch profile", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchProfile();
  }, []);

  // Password change state
  const [pwdEditing, setPwdEditing] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [showPwd, setShowPwd] = useState(false);

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await profileService.uploadPhoto(file);
      if (res.success) {
        setBasicInfo(prev => ({ ...prev, photo: res.photoUrl }));
      }
    } catch (err) {
      alert(err.message || "Failed to upload photo");
    }
  };

  const handleExtractResume = async () => {
    if (!resumeFile) {
      alert("Please upload a PDF or DOCX resume file first.");
      return;
    }

    setIsExtracting(true);
    
    try {
      const response = await profileService.uploadResume(resumeFile);
      if (response.success) {
        setProfileData(prev => ({
          ...prev,
          skills: response.data.skills || prev.skills
        }));
        if (response.data.role) {
          setBasicInfo(prev => ({ ...prev, role: response.data.role }));
        }
        setCompletionProgress(90);
        alert(`Resume uploaded! Found ${response.data.extractedSkills?.length || 0} skills.`);
      }
    } catch (error) {
      console.error("Extraction error:", error);
      alert(error.message || "Failed to extract data. Ensure you uploaded a valid PDF or DOCX.");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleResumeUpload = (e) => {
    if (e.target.files && e.target.files[0]) {
      setResumeFile(e.target.files[0]);
    }
  };

  const saveSection = async (section, data) => {
    try {
      await profileService.updateSection(section, data);
      console.log(`Saved ${section}`);
    } catch (e) {
      console.error(`Failed to save ${section}`, e);
    }
  };

  const handleUpdateProfile = async () => {
    try {
      setIsSaving(true);
      await profileService.updateBasicInfo(basicInfo);
      await profileService.updateProfileData(profileData);
      alert("Profile updated successfully!");
    } catch (error) {
      console.error("Error updating profile", error);
      alert("Failed to update profile.");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="profile-page">
        <div className="profile-loading">
          <div className="profile-spinner" />
          <p>Loading Profile...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-page">
      {/* Page Header */}
      <div className="profile-page-header">
        <div>
          <h1 className="profile-page-title">Update Profile</h1>
          <p className="profile-page-subtitle">Keep your information up to date to get the best matches.</p>
        </div>
        <button 
          onClick={handleUpdateProfile}
          disabled={isSaving}
          className="profile-save-btn"
        >
          {isSaving ? "Saving..." : <><FiSave /> Update Profile</>}
        </button>
      </div>

      {/* Progress Bar */}
      <div className="profile-progress-bar">
        <div className="profile-progress-fill" style={{ width: `${completionProgress}%` }} />
      </div>

      <div className="profile-grid">
        
        {/* Main Content (Left) */}
        <div className="profile-main">
          
          {/* Basic Information */}
          <Card title="Basic Information" onEdit={() => setEditBasic(!editBasic)} isEditing={editBasic} onSave={async () => {
            setEditBasic(false);
            try {
              await profileService.updateBasicInfo(basicInfo);
            } catch (e) {
              console.error(e);
            }
          }}>
            <div className="basic-info-layout">
              <div className="profile-photo-wrapper">
                <img src={basicInfo.photo || "https://ui-avatars.com/api/?name=" + encodeURIComponent(basicInfo.firstName + " " + basicInfo.lastName)} alt="Profile" className="profile-photo" />
                {editBasic && (
                  <div className="profile-photo-overlay" onClick={() => photoInputRef.current?.click()}>
                    <FiUploadCloud size={20} />
                  </div>
                )}
                <input type="file" hidden ref={photoInputRef} accept="image/jpeg, image/png, image/webp" onChange={handlePhotoUpload} />
              </div>
              <div className="basic-info-fields">
                <Input label="First Name" value={basicInfo.firstName} editable={editBasic} onChange={(e) => setBasicInfo({...basicInfo, firstName: e.target.value})} />
                <Input label="Last Name" value={basicInfo.lastName} editable={editBasic} onChange={(e) => setBasicInfo({...basicInfo, lastName: e.target.value})} />
                <Input label="Email Address" value={basicInfo.email} editable={editBasic} type="email" onChange={(e) => setBasicInfo({...basicInfo, email: e.target.value})} />
                <Input label="Current Role" value={basicInfo.role} editable={editBasic} onChange={(e) => setBasicInfo({...basicInfo, role: e.target.value})} />
              </div>
            </div>
          </Card>

          {/* About / Bio */}
          <SectionCard title="About / Bio" section="about" value={profileData.about} onChange={(v) => setProfileData({...profileData, about: v})} type="textarea" />

          {/* Experience */}
          <ListSectionCard 
            title="Experience / Internships" 
            items={profileData.experience} 
            onAdd={() => setProfileData({...profileData, experience: [...profileData.experience, { id: Date.now(), role: "New Role", company: "Company", duration: "Duration" }]})}
            onDelete={(id) => setProfileData({...profileData, experience: profileData.experience.filter(exp => exp.id !== id)})}
            renderItem={(item) => (
              <div>
                <h4 className="list-item-title">{item.role}</h4>
                <p className="list-item-meta">{item.company} &bull; <span>{item.duration}</span></p>
                {item.description && <p className="list-item-desc">{item.description}</p>}
              </div>
            )}
          />

          {/* Education */}
          <ListSectionCard 
            title="Education" 
            items={profileData.education} 
            onAdd={() => setProfileData({...profileData, education: [...profileData.education, { id: Date.now(), degree: "Degree", institution: "Institution", year: "Year" }]})}
            onDelete={(id) => setProfileData({...profileData, education: profileData.education.filter(edu => edu.id !== id)})}
            renderItem={(item) => (
              <div>
                <h4 className="list-item-title">{item.degree}</h4>
                <p className="list-item-meta">{item.institution} &bull; <span>{item.year}</span></p>
              </div>
            )}
          />

          {/* Projects */}
          <ListSectionCard 
            title="Projects" 
            items={profileData.projects} 
            onAdd={() => setProfileData({...profileData, projects: [...profileData.projects, { id: Date.now(), title: "Project Title", description: "Description here" }]})}
            onDelete={(id) => setProfileData({...profileData, projects: profileData.projects.filter(proj => proj.id !== id)})}
            renderItem={(item) => (
              <div>
                <h4 className="list-item-title">{item.title}</h4>
                <p className="list-item-desc">{item.description}</p>
              </div>
            )}
          />

          {/* Certifications & Achievements */}
          <div className="profile-two-col">
             <SectionCard title="Achievements" section="achievements" value={profileData.achievements} onChange={(v) => setProfileData({...profileData, achievements: v})} type="textarea" />
             <ListSectionCard 
                title="Certifications" 
                items={profileData.certifications} 
                onAdd={() => setProfileData({...profileData, certifications: [...profileData.certifications, { id: Date.now(), name: "Cert Name", issuer: "Issuer" }]})}
                onDelete={(id) => setProfileData({...profileData, certifications: profileData.certifications.filter(cert => cert.id !== id)})}
                renderItem={(item) => (
                  <div>
                    <h4 className="list-item-title" style={{ fontSize: '13px' }}>{item.name}</h4>
                    <p className="list-item-desc" style={{ fontSize: '12px' }}>{item.issuer}</p>
                  </div>
                )}
              />
          </div>
          
        </div>

        {/* Sidebar Area (Right) */}
        <div className="profile-sidebar">

          {/* Resume Upload & Extract */}
          <div className="profile-card">
            <div className="profile-card-header">
              <h3 className="profile-card-title">
                <FiUploadCloud className="profile-card-icon" /> Resume & Extraction
              </h3>
              <p className="profile-card-desc">Upload your resume to automatically fill your profile sections.</p>
            </div>

            <div className="resume-upload-area">
              {/* File Upload */}
              <div className="resume-dropzone" onClick={() => fileInputRef.current?.click()}>
                <input type="file" hidden ref={fileInputRef} onChange={handleResumeUpload} accept=".pdf,.doc,.docx" />
                {resumeFile ? (
                  <div className="resume-uploaded">
                    <FiCheckCircle size={20} className="resume-check-icon" />
                    <span>{resumeFile.name}</span>
                  </div>
                ) : (
                  <div className="resume-placeholder">
                    <FiUploadCloud size={20} />
                    <span>Click or drag PDF/DOCX</span>
                  </div>
                )}
              </div>

              <div className="resume-divider">
                <span>OR</span>
              </div>

              {/* Link Upload */}
              <div className="resume-link-input">
                <FiLink className="resume-link-icon" />
                <input 
                  type="url" 
                  placeholder="Paste Drive / Portfolio Link" 
                  value={resumeLink}
                  onChange={(e) => setResumeLink(e.target.value)}
                />
              </div>

              <button 
                onClick={handleExtractResume}
                disabled={isExtracting || (!resumeFile && !resumeLink)}
                className="resume-extract-btn"
              >
                {isExtracting ? "Extracting Details..." : "Extract & Fill Profile"}
              </button>
            </div>
          </div>

          {/* Skills */}
          <Card title="Skills" onEdit={() => {}} isEditing={false}>
            <div className="skills-list">
              {profileData.skills.map(skill => (
                <span key={skill} className="skill-chip">{skill}</span>
              ))}
              <button className="skill-add-btn">
                <FiPlus /> Add
              </button>
            </div>
          </Card>

          {/* Coding Profiles */}
          <Card title="Coding Profiles" onEdit={() => {}} isEditing={false}>
            <div className="coding-profiles-list">
              <Input label="GitHub" value={profileData.codingProfiles.github} editable={false} placeholder="github.com/username" />
              <Input label="LeetCode" value={profileData.codingProfiles.leetcode} editable={false} placeholder="leetcode.com/username" />
              <Input label="CodeChef" value={profileData.codingProfiles.codechef} editable={false} placeholder="codechef.com/users/username" />
            </div>
          </Card>

          {/* Connected Emails */}
          <div className="profile-card">
            <div className="profile-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 className="profile-card-title">
                  <FiMail className="profile-card-icon" /> Connected Mails
                </h3>
                <p className="profile-card-desc">Connect up to 3 email addresses.</p>
              </div>
              <span className="connected-count">{profileData.connectedMails.length} / 3</span>
            </div>
             
            <div className="connected-mails-list">
              {profileData.connectedMails.map((mail, idx) => {
                const isGoogle = mail.includes('@gmail.com');
                const isMicrosoft = mail.includes('@outlook.com') || mail.includes('@hotmail.com');
                return (
                  <div key={idx} className="connected-mail-item">
                    <div className="connected-mail-icon">
                      {isGoogle ? (
                        <img src="https://www.svgrepo.com/show/475656/google-color.svg" width="16" height="16" alt="Google" />
                      ) : isMicrosoft ? (
                        <img src="https://www.svgrepo.com/show/475661/microsoft-color.svg" width="16" height="16" alt="Microsoft" />
                      ) : (
                        <FiMail size={14} />
                      )}
                    </div>
                    <span className="connected-mail-address">{mail}</span>
                    <button 
                      onClick={() => setProfileData({...profileData, connectedMails: profileData.connectedMails.filter((_, i) => i !== idx)})}
                      className="connected-mail-remove"
                      title="Remove Email"
                    >
                      <FiTrash2 size={14} />
                    </button>
                  </div>
                );
              })}
              
              {profileData.connectedMails.length < 3 && (
                <div className="connected-mail-add">
                  <input 
                    id="newEmailInput"
                    type="email" 
                    placeholder="Enter new email address..." 
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = e.target.value.trim();
                        if (val && val.includes('@')) {
                          setProfileData({...profileData, connectedMails: [...profileData.connectedMails, val]});
                          e.target.value = '';
                        }
                      }
                    }}
                  />
                  <button 
                    onClick={() => {
                      const input = document.getElementById('newEmailInput');
                      const val = input.value.trim();
                      if (val && val.includes('@')) {
                        setProfileData({...profileData, connectedMails: [...profileData.connectedMails, val]});
                        input.value = '';
                      }
                    }}
                    className="connected-mail-add-btn"
                  >
                    <FiPlus size={14} /> Add
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Change Password */}
          <div className="profile-card">
            <div className="profile-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="profile-card-title">
                <FiLock className="profile-card-icon" /> Security
              </h3>
              <button 
                onClick={() => setPwdEditing(!pwdEditing)} 
                className="pwd-toggle-btn"
              >
                {pwdEditing ? "Cancel" : "Change Password"}
              </button>
            </div>

            {pwdEditing && (
              <div className="pwd-form">
                <PwdInput label="Current Password" value={passwords.current} onChange={(e) => setPasswords({...passwords, current: e.target.value})} show={showPwd} toggle={() => setShowPwd(!showPwd)} />
                <PwdInput label="New Password" value={passwords.new} onChange={(e) => setPasswords({...passwords, new: e.target.value})} show={showPwd} toggle={() => setShowPwd(!showPwd)} />
                <PwdInput label="Confirm New" value={passwords.confirm} onChange={(e) => setPasswords({...passwords, confirm: e.target.value})} show={showPwd} toggle={() => setShowPwd(!showPwd)} />
                <button 
                  onClick={async () => {
                    if (passwords.new !== passwords.confirm) {
                      alert("New passwords do not match.");
                      return;
                    }
                    try {
                      await profileService.changePassword(passwords);
                      alert("Password updated");
                      setPwdEditing(false);
                      setPasswords({ current: "", new: "", confirm: "" });
                    } catch (e) {
                      alert("Failed to update password");
                    }
                  }}
                  className="pwd-submit-btn"
                >
                  Update Password
                </button>
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}

// ── Subcomponents ──

function Card({ title, children, onEdit, isEditing, onSave }) {
  const ref = useScrollAnimation({ delay: "delay-100" });
  return (
    <div ref={ref} className="profile-card">
      <div className="profile-card-header-row">
        <h3 className="profile-card-title">{title}</h3>
        {isEditing ? (
          <div className="profile-card-actions">
            <button onClick={onEdit} className="card-action-btn" title="Cancel"><FiX size={16} /></button>
            <button onClick={onSave} className="card-action-btn card-action-btn--save" title="Save"><FiCheckCircle size={16} /></button>
          </div>
        ) : (
          <button onClick={onEdit} className="card-action-btn" title="Edit"><FiEdit2 size={16} /></button>
        )}
      </div>
      {children}
    </div>
  );
}

function SectionCard({ title, section, value, onChange, type = "text" }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title={title} isEditing={editing} onEdit={() => setEditing(!editing)} onSave={() => setEditing(false)}>
      {editing ? (
        type === "textarea" ? (
          <textarea 
            value={value} 
            onChange={(e) => onChange(e.target.value)}
            className="profile-textarea"
          />
        ) : (
          <input 
            type="text" 
            value={value} 
            onChange={(e) => onChange(e.target.value)}
            className="profile-text-input"
          />
        )
      ) : (
        <p className="profile-text-value">{value || <span className="profile-text-empty">Not provided</span>}</p>
      )}
    </Card>
  );
}

function ListSectionCard({ title, items, onAdd, onDelete, renderItem }) {
  const ref = useScrollAnimation({ delay: "delay-[150ms]" });
  return (
    <div ref={ref} className="profile-card">
      <div className="profile-card-header-row">
        <h3 className="profile-card-title">{title}</h3>
        <button onClick={onAdd} className="card-action-btn" title="Add"><FiPlus size={16} /></button>
      </div>
      <div className="list-items">
        {items.length === 0 ? (
          <p className="list-empty">No items added yet. Click + to add.</p>
        ) : (
          items.map((item, index) => (
            <div key={item.id} className={`list-item ${index !== items.length - 1 ? 'list-item--bordered' : ''}`}>
               <div className="list-item-actions">
                  <button className="card-action-btn"><FiEdit2 size={13} /></button>
                  {onDelete && <button onClick={() => onDelete(item.id)} className="card-action-btn card-action-btn--danger"><FiTrash2 size={13} /></button>}
               </div>
               {renderItem(item)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Input({ label, value, onChange, editable, type = "text", placeholder }) {
  return (
    <div className="profile-input-group">
      <label className="profile-input-label">{label}</label>
      {editable ? (
        <input 
          type={type} 
          value={value} 
          onChange={onChange}
          placeholder={placeholder}
          className="profile-text-input"
        />
      ) : (
        <div className="profile-input-value">{value || <span className="profile-text-empty">N/A</span>}</div>
      )}
    </div>
  );
}

function PwdInput({ label, value, onChange, show, toggle }) {
  return (
    <div className="pwd-input-wrapper">
      <input 
        type={show ? "text" : "password"} 
        placeholder={label}
        value={value}
        onChange={onChange}
        className="profile-text-input"
      />
      <button onClick={toggle} className="pwd-eye-btn">
        {show ? <FiEyeOff size={15} /> : <FiEye size={15} />}
      </button>
    </div>
  );
}
