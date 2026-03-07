from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str
    usajobs_api_key: str = ""
    db_path: str = "data/jobfinder.db"
    scrape_interval_hours: int = 6
    min_salary: int = 150000
    min_hourly_rate: int = 95
    host: str = "0.0.0.0"
    port: int = 8085
    resume_path: str = "data/resume.txt"

    model_config = {"env_prefix": "JOBFINDER_"}
