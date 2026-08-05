mod model;
mod sync;
mod validation;

pub use model::*;
pub use sync::*;
pub use validation::{validate_document, ValidationError};

pub const DOCUMENT_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_DOCUMENT_ID: &str = "default";
