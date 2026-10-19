// Global error handler middleware
export const errorHandler = (err, req, res, next) => {
  console.error('❌ SERVER ERROR:', err.message);
  console.error('Stack:', err.stack);
  console.error('Request:', {
    method: req.method,
    url: req.url,
    body: req.body,
    params: req.params,
    query: req.query
  });

  // Default error
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  // MySQL errors
  if (err.code === 'ER_DUP_ENTRY') {
    statusCode = 409;
    message = 'Duplicate entry. Record already exists';
    console.error('❌ MySQL Duplicate Entry Error:', err.sqlMessage);
  } else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    statusCode = 400;
    message = 'Invalid reference. Related record does not exist';
    console.error('❌ MySQL Reference Error:', err.sqlMessage);
  } else if (err.code === 'ER_ROW_IS_REFERENCED_2') {
    statusCode = 400;
    message = 'Cannot delete. Record is referenced by other records';
    console.error('❌ MySQL Reference Error:', err.sqlMessage);
  } else if (err.code && err.code.startsWith('ER_')) {
    console.error('❌ MySQL Error:', err.code, err.sqlMessage);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  }

  res.status(statusCode).json({
    success: false,
    message,
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// 404 handler
export const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
};
