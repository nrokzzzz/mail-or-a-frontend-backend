import React, { useState, useEffect } from "react";
import axiosClient from "../../helpers/axiosClient";

const Inbox = ({ selectedFilter, selectedSubFilter }) => {
  const [mails, setMails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedMail, setSelectedMail] = useState(null);

  useEffect(() => {
    const fetchEmails = async () => {
      try {
        setLoading(true);
        const res = await axiosClient.get("/api/emails");
        setMails(res.data);
      } catch (err) {
        console.error("Failed to fetch emails:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchEmails();
  }, []);

  // Filter logic
  let filtered = mails;

  if (selectedFilter !== "All") {
    filtered = filtered.filter((mail) => {
      let filterCategory = selectedFilter.toLowerCase();
      if (filterCategory === "workshops") filterCategory = "workshop";
      return mail.category.toLowerCase() === filterCategory;
    });
  }

  if (selectedSubFilter) {
    if (selectedSubFilter === "notregistered") {
      filtered = filtered.filter((mail) => mail.type === "registration");
    } else {
      filtered = filtered.filter((mail) => mail.type === selectedSubFilter);
    }
  }

  if (loading) {
    return <div className="inbox-container"><div className="inbox-header"><h2>Loading...</h2></div></div>;
  }

  return (
    <div className="inbox-container">
      <div className="inbox-header">
        <h2>Inbox {filtered.length > 0 && `(${filtered.length})`}</h2>
      </div>

      <div className="mail-list">
        {filtered.length === 0 ? (
          <p className="no-mails">No mails found</p>
        ) : (
          filtered.map((mail) => (
            <div className="mail-item" key={mail._id} onClick={() => setSelectedMail(mail)}>
              <div className="mail-item-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                 <p className="mail-name" style={{ fontWeight: 'bold', margin: 0 }}>{mail.subject}</p>
                 <span className="mail-date" style={{ fontSize: '0.85em', color: '#888' }}>
                   {new Date(mail.receivedAt).toLocaleDateString()}
                 </span>
              </div>
              <p className="mail-email" style={{ fontSize: '0.9em', color: '#555', marginBottom: '8px' }}>From: {mail.from}</p>
              <p className="preview" style={{ color: '#444', lineHeight: '1.4' }}>{mail.snippet}</p>

              <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                <span className={`status-badge ${mail.category}`} style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border-color)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.8em', textTransform: 'capitalize' }}>
                  {mail.category}
                </span>
                <span className={`status-badge ${mail.type}`} style={{ backgroundColor: 'var(--primary-color)', color: 'white', padding: '4px 8px', borderRadius: '4px', fontSize: '0.8em', textTransform: 'capitalize' }}>
                  {mail.type}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {selectedMail && (
        <div className="modal-overlay" onClick={() => setSelectedMail(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '8px' }}>{selectedMail.subject}</h3>
            <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '16px' }}>
              <strong>From:</strong> {selectedMail.from} <br/>
              <strong>Date:</strong> {new Date(selectedMail.receivedAt).toLocaleString()}
            </p>
            <div className="modal-body" style={{ maxHeight: '400px', overflowY: 'auto', padding: '10px', background: 'var(--hover-bg)', borderRadius: '6px' }}>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, color: 'var(--text-primary)' }}>
                {selectedMail.body || selectedMail.snippet}
              </pre>
            </div>
            
            {/* Show deadline if it exists (for registrations/inprogress) */}
            {selectedMail.deadlineDate && (
              <p style={{ marginTop: '16px', color: '#e53e3e', fontWeight: 'bold' }}>
                Deadline: {new Date(selectedMail.deadlineDate).toLocaleDateString()}
              </p>
            )}

            <button className="close-btn" onClick={() => setSelectedMail(null)} style={{ marginTop: '20px' }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Inbox;
