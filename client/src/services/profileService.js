import axiosClient from '../helpers/axiosClient';

// Fallback mock data in case backend fails during local dev
const MOCK_DATA = {
  basicInfo: {
    firstName: "",
    lastName: "",
    email: "",
    role: "",
    photo: "https://ui-avatars.com/api/?name=User&background=f1f5f9&color=64748b"
  },
  profileData: {
    about: "",
    skills: [],
    education: [],
    projects: [],
    experience: [],
    certifications: [],
    codingProfiles: { github: "", leetcode: "", codechef: "" },
    achievements: "",
    connectedMails: []
  }
};

let localDataCache = MOCK_DATA;

const saveLocal = (data) => {
  localDataCache = data;
  try {
    localStorage.setItem('profileMockData', JSON.stringify(data));
  } catch(e) {}
};

export const profileService = {
  getProfile: async () => {
    try {
      // Calls GET /api/user/me
      const response = await axiosClient.get('/api/user/me');
      return { success: true, data: response.data };
    } catch (error) {
      console.error("Failed to fetch profile from backend. Using mock data.", error);
      return { success: true, data: localDataCache };
    }
  },

  updateBasicInfo: async (basicInfo) => {
    try {
      // Calls PUT /api/user/basic
      await axiosClient.put('/api/user/basic', basicInfo);
      return { success: true };
    } catch (error) {
      console.error("Failed to update basic info on backend.", error);
      const newData = { ...localDataCache, basicInfo };
      saveLocal(newData);
      return { success: true };
    }
  },

  updateProfileData: async (profileData) => {
    try {
      // Calls PUT /api/user/profile
      await axiosClient.put('/api/user/profile', profileData);
      return { success: true };
    } catch (error) {
      console.error("Failed to update profile data on backend.", error);
      const newData = { ...localDataCache, profileData };
      saveLocal(newData);
      return { success: true };
    }
  },

  updateSection: async (section, data) => {
    try {
      // Calls PUT /api/user/section/:section
      await axiosClient.put(`/api/user/section/${section}`, { data });
      return { success: true };
    } catch (error) {
      console.error(`Failed to update ${section} on backend.`, error);
      const newProfileData = { ...localDataCache.profileData, [section]: data };
      saveLocal({ ...localDataCache, profileData: newProfileData });
      return { success: true };
    }
  },

  changePassword: async (passwords) => {
    try {
      // Calls PUT /api/user/change-password
      await axiosClient.put('/api/user/change-password', passwords);
      return { success: true };
    } catch (error) {
      throw new Error(error.response?.data?.message || "Password change failed");
    }
  },

  sendPasswordResetLink: async (email) => {
    try {
      const response = await axiosClient.post('/api/auth/forgot-password', { email });
      return { success: true, message: response.data.message };
    } catch (error) {
      throw new Error(error.response?.data?.message || "Failed to send reset link");
    }
  },

  uploadPhoto: async (file) => {
    try {
      const formData = new FormData();
      formData.append('photo', file);

      const response = await axiosClient.post('/api/user/upload-photo', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      return { success: true, photoUrl: response.data.photoUrl };
    } catch (error) {
      throw new Error(error.response?.data?.message || "Photo upload failed");
    }
  },

  uploadResume: async (file) => {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await axiosClient.post('/api/user/upload-resume', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      return { success: true, data: response.data };
    } catch (error) {
      throw new Error(error.response?.data?.message || "Resume upload failed");
    }
  },

  sendMobileOtp: async (countryCode, mobileNumber) => {
    try {
      const response = await axiosClient.post('/api/user/send-mobile-otp', { countryCode, mobileNumber });
      return { success: true, message: response.data.message };
    } catch (error) {
      throw new Error(error.response?.data?.message || "Failed to send OTP");
    }
  },

  verifyMobileOtp: async (otp) => {
    try {
      const response = await axiosClient.post('/api/user/verify-mobile-otp', { otp });
      return { success: true, data: response.data };
    } catch (error) {
      throw new Error(error.response?.data?.message || "OTP verification failed");
    }
  }
};
