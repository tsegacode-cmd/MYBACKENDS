import jwt from 'jsonwebtoken';

// Verify JWT token
export const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tokenPurpose === 'utility-payment-guest') {
      return res.status(401).json({
        success: false,
        message: 'This token cannot be used for this resource'
      });
    }
    req.user = {
      ...decoded,
      isRoot: decoded.isRoot === true || ['root', 'admin'].includes(String(decoded.role || '').toLowerCase())
    };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

export const authenticateOptional = (req, res, next) => {
  if (!req.headers.authorization) return next();

  try {
    const token = req.headers.authorization.split(' ')[1];
    if (!token) throw new Error('Authorization token is missing.');

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tokenPurpose === 'utility-payment-guest') {
      return res.status(401).json({
        success: false,
        message: 'This token cannot be used for this resource'
      });
    }
    req.user = {
      ...decoded,
      isRoot: decoded.isRoot === true || ['root', 'admin'].includes(String(decoded.role || '').toLowerCase())
    };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

export const authenticateUtilityRequest = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tokenPurpose === 'utility-payment-guest') {
      if (decoded.role !== 'utility_guest' || typeof decoded.id !== 'string' || !decoded.id) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired token'
        });
      }
      req.user = {
        id: `utility-guest:${decoded.id}`,
        role: decoded.role,
        isRoot: false
      };
    } else {
      req.user = {
        ...decoded,
        isRoot: decoded.isRoot === true || ['root', 'admin'].includes(String(decoded.role || '').toLowerCase())
      };
    }
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

// Check user role
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions'
      });
    }

    next();
  };
};
