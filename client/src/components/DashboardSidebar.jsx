import React, { useState } from "react";

const Sidebar = ({ activeFilter, setActiveFilter, subFilter, setSubFilter, isOpen, onClose }) => {
  const [activeMenu, setActiveMenu] = useState(null);

  const toggleMenu = (menu) => {
    setActiveMenu(activeMenu === menu ? null : menu);
    setActiveFilter(menu);
    setSubFilter("");
  };

  const handleSubFilter = (value) => {
    setSubFilter(value);
    onClose(); // close sidebar on mobile after selecting a filter
  };

  const handleMainFilter = (filter) => {
    setActiveFilter(filter);
    setSubFilter("");
    setActiveMenu(null);
    onClose(); // close sidebar on mobile
  };

  return (
    <div className={`sidebar ${isOpen ? "open" : ""}`}>
      {/* Close button — mobile only */}
      <button className="sidebar-close-btn" onClick={onClose}>&#10005;</button>

      <h3 className="filter-title">Filters</h3>

      {/* ALL */}
      <button
        className={`filter ${activeFilter === "All" ? "active" : ""}`}
        onClick={() => handleMainFilter("All")}
      >
        All
      </button>

      {/* Categories with submenu */}
      {["Internship", "Job", "Hackathon", "Workshops"].map((category) => (
        <div className="menu" key={category}>
          <button
            className={`filter ${activeFilter === category ? "active" : ""}`}
            onClick={() => toggleMenu(category)}
          >
            {category}
          </button>

          {activeMenu === category && (
            <div className="submenu">
              <p className="cursor-pointer hover:text-orange-500 active:scale-95 transition-all duration-200" onClick={() => handleSubFilter("registered")}>Registered</p>
              <p className="cursor-pointer hover:text-orange-500 active:scale-95 transition-all duration-200" onClick={() => handleSubFilter("notregistered")}>Not Registered</p>
              <p className="cursor-pointer hover:text-orange-500 active:scale-95 transition-all duration-200" onClick={() => handleSubFilter("inprogress")}>In Progress</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default Sidebar;
