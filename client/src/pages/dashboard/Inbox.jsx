import React, { useState } from "react";

const Inbox = ({ selectedFilter, selectedSubFilter }) => {
  const [mails] = useState([
    
  ]);

  let filtered = mails;

  if (selectedSubFilter) {
    filtered = filtered.filter((mail) => mail.status === selectedSubFilter);
  }

  return (
    <div className="inbox-container">
      <div className="inbox-header">
        <h2>Inbox</h2>
      </div>

      <div className="mail-list">
        {filtered.length === 0 ? (
          <p className="no-mails">No mails found</p>
        ) : (
          filtered.map((mail) => (
            <div className="mail-item" key={mail.id}>
              <p className="mail-name">{mail.name}</p>
              <p className="mail-email">{mail.email}</p>
              <p className="preview">{mail.message}</p>

              <span className={`status-badge ${mail.status}`}>
                {mail.status.toUpperCase()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Inbox;
