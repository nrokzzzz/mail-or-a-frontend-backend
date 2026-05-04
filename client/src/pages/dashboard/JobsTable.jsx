import React, { useState, useEffect } from "react";
import "./JobTable.css";

function JobsTable() {

  const [jobsData, setJobsData] = useState([]);
  const [loading, setLoading] = useState(true);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [inputPage, setInputPage] = useState("");

  const rowsPerPage = 10;

  /* Fetch Data from Backend */
  useEffect(() => {
    fetch("http://localhost:5000/jobs")
      .then(res => res.json())
      .then(data => {
        setJobsData(data);
        setLoading(false);
      })
      .catch(err => {
        console.log(err);
        setLoading(false);
      });
  }, []);

  /* Loading State */
  if (loading) {
    return <h2 style={{ textAlign: "center" }}>Loading jobs...</h2>;
  }

  /* Filter Jobs */
  const filteredJobs = jobsData.filter(job =>
    job.company.toLowerCase().includes(search.toLowerCase()) ||
    job.role.toLowerCase().includes(search.toLowerCase()) ||
    job.location.toLowerCase().includes(search.toLowerCase())
  );

  /* Pagination */
  const totalPages = Math.ceil(filteredJobs.length / rowsPerPage);
  const start = (page - 1) * rowsPerPage;
  const currentData = filteredJobs.slice(start, start + rowsPerPage);

  /* Visible Pages */
  const visiblePages = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
    visiblePages.push(i);
  }

  /* Jump Page */
  const goToPage = () => {
    const num = Number(inputPage);
    if (num >= 1 && num <= totalPages) {
      setPage(num);
      setInputPage("");
    }
  };

  return (
    <div className="jobtable-page">
    <div className="container">

      <h2>Available Jobs</h2>

      <div className="topbar">
        <input
          type="text"
          placeholder="Search company / role / location"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Location</th>
            <th>Salary</th>
          </tr>
        </thead>

        <tbody>
          {currentData.length === 0 ? (
            <tr>
              <td colSpan="4" style={{ textAlign: "center" }}>
                No jobs found
              </td>
            </tr>
          ) : (
            currentData.map(job => (
              <tr key={job.id}>
                <td>{job.company}</td>
                <td>{job.role}</td>
                <td>{job.location}</td>
                <td>{job.salary} LPA</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="pagination">

        {/* Previous */}
        <button onClick={() => setPage(page === 1 ? totalPages : page - 1)}>
          ◀
        </button>

        {/* Page Numbers */}
        {visiblePages.map(p => (
          <button
            key={p}
            className={page === p ? "active" : ""}
            onClick={() => setPage(p)}
          >
            {p}
          </button>
        ))}

        {/* Last Page */}
        {visiblePages[visiblePages.length - 1] !== totalPages && (
          <>
            <span className="dots">...</span>
            <button onClick={() => setPage(totalPages)}>
              {totalPages}
            </button>
          </>
        )}

        {/* Next */}
        <button onClick={() => setPage(page === totalPages ? 1 : page + 1)}>
          ▶
        </button>

      </div>

      <div className="jump">
        <span>Enter Page no.</span>

        <input
          type="number"
          placeholder="e.g 10"
          value={inputPage}
          onChange={(e) => setInputPage(e.target.value)}
        />

        <button onClick={goToPage}>▶</button>
      </div>

    </div>
    </div>
  );
}

export default JobsTable;
