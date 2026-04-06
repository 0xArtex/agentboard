// Centralized error handling middleware

function errorHandler(err, req, res, _next) {
  console.error(`[error] ${err.message}`);
  if (err.stack && process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: {
      message: err.message || 'Internal server error',
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  });
}

// Async route wrapper — catches promise rejections
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, asyncHandler };
